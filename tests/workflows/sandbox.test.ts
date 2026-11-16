import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createDb } from "@clowder/db";
import { queueSandboxDeployment, type SandboxDeploymentName } from "@clowder/db/sandboxes";
import {
    clusters,
    deploymentLogs,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
    sandboxes,
    volumes,
} from "@clowder/db/schema/index";
import { destroySandbox, provisionSandbox } from "@clowder/workflows/sandbox";
import { call } from "@orpc/server";
import { asc, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { parse } from "yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { removeResources } from "../../packages/api/src/resources/removal";
import { volumesRouter } from "../../packages/api/src/routers/volumes";
import { insertUserWithOrganization } from "../users";

const PASSWORD = "hunter2-$HOME-secret";

describe("sandbox deployments", () => {
    const databaseName = `clowder_sandbox_job_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    const signal = new AbortController().signal;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let organizationId: string;
    // What the fake sidecar received and answers.
    let deployed: string[] = [];
    let removed: string[] = [];
    let removeStatus = 200;
    let volumesStatus = 200;
    // Volume names the fake cluster has no volume by.
    let missingVolumes = new Set<string>();
    let deployError: string | null = null;
    // Runs while the deploy is in flight, before Uncloud confirms it.
    let duringDeploy = async () => {};

    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) chunks.push(Buffer.from(chunk));

        const json = (status: number, body: string) => {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(body);
        };

        if (request.method === "GET" && request.url === "/api/v1/machines")
            return json(
                200,
                JSON.stringify({
                    items: [{ id: "m1", name: "hazel", state: "Up", publicIp: "203.0.113.7" }],
                }),
            );

        if (request.method === "GET" && request.url?.startsWith("/api/v1/volumes")) {
            const name = new URL(request.url, "http://sidecar").searchParams.get("names") ?? "";

            return json(
                volumesStatus,
                JSON.stringify({
                    items: missingVolumes.has(name)
                        ? []
                        : [{ machineId: "m1", machineName: "hazel", volume: {} }],
                }),
            );
        }

        if (request.method === "DELETE") {
            // A service by its name, a volume as `<machine>/<name>`.
            removed.push(
                decodeURIComponent(
                    request.url!.replace(/^\/api\/v1\/(services|machines)\//u, ""),
                ).replace("/volumes/", "/"),
            );

            return json(
                removeStatus,
                JSON.stringify(removeStatus === 200 ? { status: "ok" } : { error: "gone" }),
            );
        }

        // SAFETY: the uc client always posts `{ compose, ... }` to the deploy endpoint.
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { compose: string };
        deployed.push(Buffer.from(body.compose, "base64").toString("utf8"));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
            `data: ${JSON.stringify({ type: "plan", operations: [{ action: "run", service: "sandbox-brave-otter", name: PASSWORD }] })}\n\n`,
        );
        response.write(
            `data: ${JSON.stringify({ type: "progress", phase: "working", percent: 40, id: "pull" })}\n\n`,
        );
        await duringDeploy();
        response.end(
            deployError
                ? `data: ${JSON.stringify({ type: "error", error: deployError })}\n\n`
                : `data: {"type":"complete","status":"Deployment complete."}\n\n`,
        );
    });

    async function insertSandbox(name: SandboxDeploymentName, machine: string | null) {
        const id = randomUUID();
        const volumeId = randomUUID();

        await db
            .insert(volumes)
            .values({ id: volumeId, clusterId, name: `sandbox-s-${id.slice(0, 8)}-data` });
        await db
            .insert(resources)
            .values({ id, name: `s-${id.slice(0, 8)}`, type: "sandbox", projectId });
        await db.insert(sandboxes).values({
            resourceId: id,
            organizationId,
            slug: `s-${id.slice(0, 8)}`,
            provider: "uncloud",
            clusterId,
            machine,
            sshPort: 30000 + Math.floor(Math.random() * 2000),
            volumeId,
            image: `pkg.bar/sandbox:latest@sha256:${"a".repeat(64)}`,
            status: name === "ProvisionSandbox" ? "provisioning" : "destroying",
            authorizedKeys: `ssh-ed25519 ${"A".repeat(68)} me@laptop`,
            password: PASSWORD,
            ttlSeconds: 3600,
        });

        const deploymentId = await queueSandboxDeployment(db, id, clusterId, name);

        return { id, volumeId, deploymentId };
    }

    async function load(id: string, deploymentId: string) {
        const [sandbox] = await db.select().from(sandboxes).where(eq(sandboxes.resourceId, id));

        const [deployment] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, deploymentId));

        const logs = await db
            .select()
            .from(deploymentLogs)
            .where(eq(deploymentLogs.deploymentId, deploymentId))
            .orderBy(asc(deploymentLogs.id));

        return { sandbox: sandbox!, deployment: deployment!, logs };
    }

    beforeAll(async () => {
        vi.stubEnv("APP_SECRET", "sandbox-job-test-secret-at-least-32-bytes");
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        organizationId = await insertUserWithOrganization(db, "owner", "Owner", "o@x.test");

        server.listen(0, "127.0.0.1");
        await once(server, "listening");

        // SAFETY: a TCP server listening on a port always reports an AddressInfo.
        const { port } = server.address() as AddressInfo;

        await db.insert(clusters).values({
            id: clusterId,
            name: "Cluster",
            sidecarUrl: `http://127.0.0.1:${port}`,
            sidecarToken: "token",
            organizationId,
        });
        await db.insert(projects).values({ id: projectId, name: "Project", clusterId });
    }, 30_000);

    afterAll(async () => {
        vi.unstubAllEnvs();
        server.close();
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    beforeEach(() => {
        deployed = [];
        removed = [];
        removeStatus = 200;
        volumesStatus = 200;
        missingVolumes = new Set();
        deployError = null;
        duringDeploy = async () => {};
    });

    it("deploys the microVM as its deployment and records where to SSH", async () => {
        const { id, volumeId, deploymentId } = await insertSandbox("ProvisionSandbox", null);

        await provisionSandbox(db, deploymentId, signal);

        const { sandbox, deployment, logs } = await load(id, deploymentId);
        const service = parse(deployed[0]!).services[`sandbox-${sandbox.slug}`];

        expect(sandbox).toMatchObject({ status: "running", sshHost: "203.0.113.7" });
        expect(deployment).toMatchObject({ status: "ready", resourceId: id });
        expect(service).toMatchObject({
            image: sandbox.image,
            environment: {
                SANDBOX_HOSTNAME: sandbox.slug,
                // Escaped, so Compose doesn't expand `$HOME`.
                SANDBOX_PASSWORD: PASSWORD.replaceAll("$", "$$"),
                SANDBOX_TTL_SECONDS: "3600",
            },
            devices: ["/dev/kvm:/dev/kvm", "/dev/net/tun:/dev/net/tun"],
            volumes: [`sandbox-${sandbox.slug}-data:/var/lib/sandbox`],
            "x-ports": [`${sandbox.sshPort}:22/tcp@host`],
        });
        expect(service["x-machines"]).toBeUndefined();
        // Every line, pull progress included, lands in the deployment's log for its timeline.
        expect(logs.map((log) => log.metadata.event)).toContain("progress");
        expect(logs.at(-1)?.text).toBe("SSH is open at 203.0.113.7:" + sandbox.sshPort + ".");
        expect(JSON.stringify(logs)).not.toContain("hunter2");
        expect(JSON.stringify(logs)).toContain("[REDACTED]");
        // The deployment keeps what it ran, minus the password.
        expect(
            parse(deployment.spec!).services[`sandbox-${sandbox.slug}`].environment,
        ).toMatchObject({ SANDBOX_PASSWORD: "********", SANDBOX_TTL_SECONDS: "3600" });

        const [volume] = await db.select().from(volumes).where(eq(volumes.id, volumeId));

        expect(volume?.machine).toBe("hazel");
    });

    it("still runs when looking up its machine fails after the deploy", async () => {
        const { id, deploymentId } = await insertSandbox("ProvisionSandbox", null);

        volumesStatus = 500;
        await provisionSandbox(db, deploymentId, signal);

        const { sandbox, deployment, logs } = await load(id, deploymentId);

        expect(sandbox).toMatchObject({ status: "running", sshHost: null });
        expect(deployment.status).toBe("ready");
        expect(logs.some((log) => log.text.startsWith("Couldn't look up where it runs"))).toBe(
            true,
        );
    });

    it("pins a sandbox to its machine", async () => {
        const { id, deploymentId } = await insertSandbox("ProvisionSandbox", "hazel");

        await provisionSandbox(db, deploymentId, signal);

        const { sandbox } = await load(id, deploymentId);

        expect(parse(deployed[0]!).services[`sandbox-${sandbox.slug}`]["x-machines"]).toBe("hazel");
    });

    it("removes the service, then the sandbox resource, and leaves its volume as a card", async () => {
        const { id, volumeId, deploymentId } = await insertSandbox("DestroySandbox", "hazel");

        // Already gone, as after a retry, still counts as removed.
        removeStatus = 404;
        await destroySandbox(db, deploymentId, signal);

        expect(removed).toEqual([`sandbox-s-${id.slice(0, 8)}`]);
        expect(await db.select().from(resources).where(eq(resources.id, id))).toEqual([]);
        expect(await db.select().from(sandboxes).where(eq(sandboxes.resourceId, id))).toEqual([]);

        const [volume] = await db.select().from(volumes).where(eq(volumes.id, volumeId));

        const [card] = await db
            .select()
            .from(resources)
            .where(eq(resources.id, volume!.resourceId!));

        expect(card).toMatchObject({ type: "volume", name: volume!.name, projectId });
    });

    it("removes the VM again when the sandbox is destroyed mid-deploy", async () => {
        const { id, deploymentId } = await insertSandbox("ProvisionSandbox", null);

        duringDeploy = async () => {
            await db
                .update(sandboxes)
                .set({ status: "destroying" })
                .where(eq(sandboxes.resourceId, id));
        };

        await provisionSandbox(db, deploymentId, signal);

        const { sandbox } = await load(id, deploymentId);

        expect(sandbox.status).toBe("destroying");
        expect(removed).toEqual([`sandbox-${sandbox.slug}`]);
    });

    it("skips an attempt that was cancelled before it started", async () => {
        const { id, deploymentId } = await insertSandbox("ProvisionSandbox", null);

        await db
            .update(deployments)
            .set({ status: "cancelled" })
            .where(eq(deployments.id, deploymentId));
        await provisionSandbox(db, deploymentId, signal);

        expect(deployed).toEqual([]);
        expect((await load(id, deploymentId)).sandbox.status).toBe("provisioning");
    });

    it("fails the deployment and the sandbox with Uncloud's reason", async () => {
        const { id, deploymentId } = await insertSandbox("ProvisionSandbox", null);

        deployError = "machine hazel has no /dev/kvm";
        await expect(provisionSandbox(db, deploymentId, signal)).rejects.toThrow("no /dev/kvm");

        const { sandbox, deployment, logs } = await load(id, deploymentId);

        expect(sandbox.status).toBe("failed");
        expect(deployment).toMatchObject({ status: "failed" });
        expect(deployment.error).toContain("no /dev/kvm");
        expect(logs.at(-1)).toMatchObject({ metadata: { level: "error" } });
    });

    function owner() {
        // SAFETY: authorization reads only identity and active organization.
        return {
            db,
            session: { user: { id: "owner" }, session: { activeOrganizationId: organizationId } },
        } as Context;
    }

    async function volumeCard(name: string) {
        const resourceId = randomUUID();

        await db.insert(resources).values({ id: resourceId, name, type: "volume", projectId });
        await db.insert(volumes).values({ id: randomUUID(), clusterId, name, resourceId });

        return resourceId;
    }

    it("deletes a volume card and its data from every machine that has it", async () => {
        const resourceId = await volumeCard("sandbox-old-data");

        await call(volumesRouter.remove, { projectId, resourceId }, { context: owner() });

        // No `?force`: Docker refusing a volume in use is the safety net.
        expect(removed).toEqual(["hazel/sandbox-old-data"]);
        expect(await db.select().from(volumes).where(eq(volumes.name, "sandbox-old-data"))).toEqual(
            [],
        );
        expect(await db.select().from(resources).where(eq(resources.id, resourceId))).toEqual([]);
    });

    it("keeps a volume card whose volume the machine refuses to delete", async () => {
        const resourceId = await volumeCard("busy-data");

        removeStatus = 409;
        await expect(
            call(volumesRouter.remove, { projectId, resourceId }, { context: owner() }),
        ).rejects.toThrow('Could not delete "busy-data"');
        expect(
            await db.select().from(volumes).where(eq(volumes.resourceId, resourceId)),
        ).toHaveLength(1);
    });

    it("leaves only the volumes a deleted resource owned, and created, as cards", async () => {
        const id = randomUUID();

        const spec = [
            "services:",
            "  web:",
            "    image: nginx",
            "    volumes: [data:/data, shared:/shared, pinned:/pinned, never:/never, moved:/moved]",
            "volumes:",
            "  data: {}",
            "  shared:",
            "    external: true",
            "  pinned:",
            "    name: elsewhere",
            "  never: {}",
            "  moved: {}",
        ].join("\n");

        await db.insert(resources).values({ id, name: "web", type: "compose", projectId, spec });
        await db.insert(deployments).values({
            id,
            jobId: id,
            clusterId,
            resourceId: id,
            name: "DeployResource",
            status: "ready",
            spec,
            finishedAt: new Date(),
        });
        await db.insert(resourceDeploymentInputs).values({ deploymentId: id, prefix: "app" });
        // A service moved out of it keeps mounting its volume by the old name.
        await db.insert(resources).values({
            id: randomUUID(),
            name: "worker",
            type: "compose",
            projectId,
            draftSpec: "services: {}\nvolumes:\n  moved:\n    name: app-moved\n",
        });
        missingVolumes = new Set(["app-never"]);

        const [resource] = await db.select().from(resources).where(eq(resources.id, id));

        await db.transaction((tx) => removeResources(tx, clusterId, [resource!], true));

        const kept = await db
            .select({ name: volumes.name, card: resources.type })
            .from(volumes)
            .innerJoin(resources, eq(resources.id, volumes.resourceId))
            .where(
                inArray(volumes.name, [
                    "app-data",
                    "app-shared",
                    "elsewhere",
                    "app-never",
                    "app-moved",
                ]),
            );

        expect(removed).toEqual(["app-web"]);
        expect(kept).toEqual([{ name: "app-data", card: "volume" }]);
    });

    it("forgets a cluster's volume cards with the cluster", async () => {
        const otherCluster = randomUUID();
        const otherProject = randomUUID();

        await db.insert(clusters).values({
            id: otherCluster,
            name: "Other",
            sidecarUrl: "http://127.0.0.1:1",
            sidecarToken: "token",
            organizationId,
        });
        await db
            .insert(projects)
            .values({ id: otherProject, name: "Other", clusterId: otherCluster });

        const resourceId = randomUUID();

        await db.insert(resources).values({
            id: resourceId,
            name: "left-data",
            type: "volume",
            projectId: otherProject,
        });
        await db
            .insert(volumes)
            .values({ id: randomUUID(), clusterId: otherCluster, name: "left-data", resourceId });

        // Both cascades reach the card; the deferred check lets them finish in either order.
        await db.delete(clusters).where(eq(clusters.id, otherCluster));
        expect(await db.select().from(volumes).where(eq(volumes.name, "left-data"))).toEqual([]);
    });
});
