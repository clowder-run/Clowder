import { ORPCError } from "@orpc/server";
import type { Database } from "@clowder/db";
import { getSandboxWork, SANDBOX_PREFIX } from "@clowder/db/sandboxes";
import { clusters, projects, resources } from "@clowder/db/schema/index";
import { openTerminal } from "@clowder/uncloud";
import { prefixName } from "@clowder/workflows/compose";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { Client, type ClientChannel } from "ssh2";
import * as v from "valibot";

import { organizationProcedure, publicProcedure, requireAuth, resourceMiddleware } from "..";
import { formatComposeFile, resourceComposePrefix } from "../compose";
import { cancellableStream } from "../stream";

export type TerminalEvent = { type: "open"; id: string } | { type: "output"; data: string };

type Shell = {
    output: Duplex;
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    close: () => void;
};

// shortcut: shells live in this process, so input must reach the server that opened them; share
// sessions across processes before running several web replicas.
const sessions = new Map<string, Shell & { userId: string }>();

const id = v.pipe(v.string(), v.uuid());

const size = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000));

/** A shell in a running container of one of the resource's own Compose services, via the sidecar. */
async function containerShell(
    db: Database,
    resource: typeof resources.$inferSelect,
    service: string | undefined,
    cols: number,
    rows: number,
): Promise<Shell> {
    const [cluster] = await db
        .select({
            sidecarUrl: clusters.sidecarUrl,
            sidecarToken: clusters.sidecarToken,
            sidecarCertificate: clusters.sidecarCertificate,
        })
        .from(clusters)
        .innerJoin(projects, eq(projects.clusterId, clusters.id))
        .where(eq(projects.id, resource.projectId));

    if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

    // Only the resource's own services: any other name could reach Clowder's or root's containers.
    const prefix = resourceComposePrefix(resource);

    const names = resource.spec?.trim()
        ? formatComposeFile(resource.spec, prefix).serviceNames
        : [];

    const name = service === undefined ? names[0] : prefixName(service, prefix);

    // Unprefixed Compose can take these names, and their containers hold the sidecar's root
    // access to the hosts, the certificates, monitoring data or another user's sandbox.
    const clowders =
        name === "sidecar" ||
        name === "caddy" ||
        name?.startsWith("clowder-monitoring-") ||
        name?.startsWith(SANDBOX_PREFIX);

    if (!name || !names.includes(name) || clowders)
        throw new ORPCError("NOT_FOUND", {
            message: "This resource has no service to open a shell in.",
        });

    const socket = await openTerminal(cluster.sidecarUrl, name, {
        token: cluster.sidecarToken,
        certificate: cluster.sidecarCertificate,
    }).catch(() => {
        throw new ORPCError("BAD_GATEWAY", {
            message: "Couldn't open a shell. Check that the cluster's sidecar is up to date.",
        });
    });

    // Until the stream reads it, an unhandled error would crash the server.
    socket.on("error", () => socket.destroy());

    const send = (message: { stdin?: string; resize?: [number, number] }) =>
        socket.write(JSON.stringify(message));

    send({ resize: [cols, rows] });

    return {
        output: socket,
        write: (data) => send({ stdin: data }),
        resize: (cols, rows) => send({ resize: [cols, rows] }),
        close: () => socket.destroy(),
    };
}

/** An SSH session into a sandbox's VM, which only works when it was given a password. */
async function sandboxShell(db: Database, resourceId: string, cols: number, rows: number) {
    const sandbox = (await getSandboxWork(db, resourceId))?.sandbox;

    if (!sandbox) throw new ORPCError("NOT_FOUND", { message: "Sandbox not found." });

    if (!sandbox.password)
        throw new ORPCError("PRECONDITION_FAILED", {
            message:
                "This sandbox only accepts SSH keys, and Clowder doesn't have your private key. Connect from your own terminal instead.",
        });

    if (sandbox.status !== "running" || !sandbox.sshHost || !sandbox.sshPort)
        throw new ORPCError("PRECONDITION_FAILED", { message: "The sandbox isn't running." });

    const client = new Client();

    // Without a listener a late error would crash the server; a dropped connection closes the
    // channel, which ends the stream.
    client.on("error", () => client.end());

    await new Promise<void>((resolve, reject) => {
        client.once("ready", resolve).once("error", reject);
        // shortcut: any host key is accepted; record the VM's key when it's provisioned to pin it.
        client.connect({
            host: sandbox.sshHost ?? undefined,
            port: sandbox.sshPort ?? undefined,
            username: "dev",
            password: sandbox.password ?? undefined,
            readyTimeout: 15_000,
        });
    }).catch((error: Error) => {
        client.end();
        throw new ORPCError("BAD_GATEWAY", {
            message: `Couldn't SSH into the sandbox: ${error.message}`,
        });
    });

    const channel = await new Promise<ClientChannel>((resolve, reject) =>
        client.shell({ term: "xterm-256color", cols, rows }, (error, channel) =>
            error ? reject(error) : resolve(channel),
        ),
    ).catch((error: Error) => {
        client.end();
        throw new ORPCError("BAD_GATEWAY", { message: `Couldn't open a shell: ${error.message}` });
    });

    channel.once("close", () => client.end());

    return {
        output: channel,
        write: (data) => channel.write(data),
        resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
        close: () => client.end(),
    } satisfies Shell;
}

export const terminalRouter = {
    /** Opens a shell, yielding its session ID first, then its output until it exits. */
    open: organizationProcedure
        .use(requireAuth)
        .input(
            v.object({
                projectId: id,
                resourceId: id,
                // The canvas's service name, without the resource's prefix; the first service when absent.
                service: v.optional(v.pipe(v.string(), v.maxLength(255))),
                cols: size,
                rows: size,
            }),
        )
        .use(resourceMiddleware)
        .handler(({ context: { db, resource, session }, input, signal }) =>
            cancellableStream(async function* (signal): AsyncGenerator<TerminalEvent> {
                const shell =
                    resource.type === "sandbox"
                        ? await sandboxShell(db, resource.id, input.cols, input.rows)
                        : await containerShell(db, resource, input.service, input.cols, input.rows);

                const sessionId = randomUUID();

                sessions.set(sessionId, { ...shell, userId: session.user.id });
                // Closing the shell ends the loop below when the client goes away.
                signal.addEventListener("abort", shell.close);

                try {
                    yield { type: "open", id: sessionId };

                    // Keeps characters split across chunks whole.
                    const decoder = new TextDecoder();

                    for await (const chunk of shell.output)
                        yield { type: "output", data: decoder.decode(chunk, { stream: true }) };
                } catch (error) {
                    // Leaving the tab destroys the shell mid-read; that is no failure.
                    if (!signal.aborted) throw error;
                } finally {
                    sessions.delete(sessionId);
                    shell.close();
                }
            }, signal),
        ),

    /** Sends keystrokes or a new size to a shell this user opened. */
    send: publicProcedure
        .use(requireAuth)
        .input(
            v.object({
                id: v.string(),
                data: v.optional(v.pipe(v.string(), v.maxLength(65_536))),
                size: v.optional(v.tuple([size, size])),
            }),
        )
        .handler(({ context: { session }, input }) => {
            const shell = sessions.get(input.id);

            if (shell?.userId !== session.user.id)
                throw new ORPCError("NOT_FOUND", { message: "This terminal has closed." });

            if (input.data) shell.write(input.data);

            if (input.size) shell.resize(...input.size);
        }),
};
