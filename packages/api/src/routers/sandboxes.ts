import { ORPCError } from "@orpc/server";
import type { Database } from "@clowder/db";
import {
    clusters,
    deployments,
    resources,
    sandboxes,
    sandboxImages,
    type SandboxStatus,
    volumes,
} from "@clowder/db/schema/index";
import { sandboxSpec } from "@clowder/workflows/sandbox";
import {
    getSandboxWork,
    queueSandboxDeployment,
    sandboxServiceName,
    type SandboxDeploymentName,
} from "@clowder/db/sandboxes";
import { deleteEmptyGroups } from "@clowder/db/groups";
import { resourceSlug } from "@clowder/db/slug";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { organizationProcedure, uncloudMiddleware } from "..";
import { parseImageReference } from "../image-reference";
import { pinImageDigest } from "../registry";
import { editableProject } from "./resources/access";

const id = v.pipe(v.string(), v.uuid());

// Uncloud's service name rule, leaving room for the `sandbox-` prefix on its service and volume.
const slug = v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(55),
    v.regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u, "Use lowercase letters, digits and hyphens."),
);

const imageReference = v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(255),
    v.check((value) => parseImageReference(value) !== null, "Enter a valid image reference."),
);

const SSH_KEY =
    /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/u;

// One public key per line, as in `authorized_keys`; blank lines are dropped.
const authorizedKeys = v.pipe(
    v.string(),
    v.maxLength(16_384),
    v.transform((value) =>
        value
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean)
            .join("\n"),
    ),
    v.check(
        (value) => value.split("\n").every((line) => SSH_KEY.test(line)),
        "Enter OpenSSH public keys, one per line.",
    ),
);

const password = v.pipe(
    v.string(),
    v.minLength(8),
    v.maxLength(256),
    v.regex(/^[^\p{Cc}]+$/u, "The password can't contain control characters."),
);

// Outside the ports services usually take, like Kubernetes NodePorts.
const SSH_PORTS = { first: 30000, last: 32767 };

// Each pick can lose to a concurrent create; a few rounds settle it.
const PORT_ATTEMPTS = 5;

const resourceInput = { projectId: id, resourceId: id };

// Everything about a sandbox except its password.
const sandboxColumns = {
    resourceId: sandboxes.resourceId,
    slug: sandboxes.slug,
    provider: sandboxes.provider,
    clusterId: sandboxes.clusterId,
    clusterName: clusters.name,
    machine: sandboxes.machine,
    sshPort: sandboxes.sshPort,
    sshHost: sandboxes.sshHost,
    volumeId: sandboxes.volumeId,
    image: sandboxes.image,
    status: sandboxes.status,
    authorizedKeys: sandboxes.authorizedKeys,
    hasPassword: sql<boolean>`${sandboxes.password} is not null`,
    ttlSeconds: sandboxes.ttlSeconds,
    createdAt: sandboxes.createdAt,
};

async function getSandbox(
    db: Database,
    organizationId: string,
    projectId: string,
    resourceId: string,
) {
    const [sandbox] = await db
        .select(sandboxColumns)
        .from(sandboxes)
        .innerJoin(resources, eq(resources.id, sandboxes.resourceId))
        .leftJoin(clusters, eq(sandboxes.clusterId, clusters.id))
        .where(
            and(
                eq(sandboxes.resourceId, resourceId),
                eq(resources.projectId, projectId),
                eq(sandboxes.organizationId, organizationId),
            ),
        )
        .limit(1);

    if (!sandbox) throw new ORPCError("NOT_FOUND", { message: "Sandbox not found." });

    return sandbox;
}

// The volume to reuse: one on the same cluster that stands on the canvas as a card, mounted by nothing.
async function getFreeVolume(db: Database, clusterId: string, volumeId: string) {
    const [volume] = await db
        .select({
            id: volumes.id,
            machine: volumes.machine,
            card: volumes.resourceId,
            cardProjectId: resources.projectId,
        })
        .from(volumes)
        .leftJoin(resources, eq(resources.id, volumes.resourceId))
        .where(and(eq(volumes.id, volumeId), eq(volumes.clusterId, clusterId)))
        .limit(1);

    if (!volume) throw new ORPCError("NOT_FOUND", { message: "Volume not found on this cluster." });

    if (!volume.card || !volume.cardProjectId)
        throw new ORPCError("CONFLICT", { message: "Another sandbox is using this volume." });

    return { ...volume, card: volume.card, cardProjectId: volume.cardProjectId };
}

// A destroyed sandbox frees its name, but its volume stays under that name until it's reused,
// which is when it's `reusedVolumeId`.
async function assertSlugFree(
    db: Database,
    organizationId: string,
    clusterId: string,
    value: string,
    reusedVolumeId: string | undefined,
) {
    const [taken] = await db
        .select({ resourceId: sandboxes.resourceId })
        .from(sandboxes)
        .where(and(eq(sandboxes.organizationId, organizationId), eq(sandboxes.slug, value)))
        .limit(1);

    if (taken) throw new ORPCError("CONFLICT", { message: "That name is taken." });

    const [kept] = await db
        .select({ id: volumes.id })
        .from(volumes)
        .where(
            and(
                eq(volumes.clusterId, clusterId),
                eq(volumes.name, `${sandboxServiceName(value)}-data`),
            ),
        )
        .limit(1);

    if (kept && kept.id !== reusedVolumeId)
        throw new ORPCError("CONFLICT", {
            message:
                "An earlier sandbox's volume has that name. Pick it as the volume, or another name.",
        });
}

async function freeSshPort(db: Database, clusterId: string) {
    const rows = await db
        .select({ port: sandboxes.sshPort })
        .from(sandboxes)
        .where(eq(sandboxes.clusterId, clusterId));

    const taken = new Set(rows.map((row) => row.port));

    for (let port = SSH_PORTS.first; port <= SSH_PORTS.last; port++) {
        if (!taken.has(port)) return port;
    }

    throw new ORPCError("PRECONDITION_FAILED", {
        message: "This cluster has no SSH ports left. Destroy a sandbox first.",
    });
}

// Moves the sandbox on from one of `from` and queues the deployment that does the work.
async function request(
    db: Database,
    organizationId: string,
    projectId: string,
    resourceId: string,
    from: SandboxStatus[],
    name: SandboxDeploymentName,
) {
    const sandbox = await getSandbox(db, organizationId, projectId, resourceId);

    const deploymentId = await db.transaction(async (tx) => {
        const [moved] = await tx
            .update(sandboxes)
            .set({ status: name === "ProvisionSandbox" ? "provisioning" : "destroying" })
            .where(and(eq(sandboxes.resourceId, resourceId), inArray(sandboxes.status, from)))
            .returning({ clusterId: sandboxes.clusterId });

        if (!moved?.clusterId) return null;

        // The destroy is underway, so the canvas no longer counts it as a change to apply.
        if (name === "DestroySandbox")
            await tx
                .update(resources)
                .set({ pendingDelete: false })
                .where(eq(resources.id, resourceId));

        return queueSandboxDeployment(tx, resourceId, moved.clusterId, name);
    });

    if (!deploymentId)
        throw new ORPCError("CONFLICT", { message: `This sandbox is ${sandbox.status}.` });

    return { deploymentId };
}

const imagesRouter = {
    list: organizationProcedure.handler(({ context: { db, organizationId } }) =>
        db
            .select({
                id: sandboxImages.id,
                provider: sandboxImages.provider,
                image: sandboxImages.image,
            })
            .from(sandboxImages)
            .where(eq(sandboxImages.organizationId, organizationId))
            .orderBy(asc(sandboxImages.provider), asc(sandboxImages.image)),
    ),
    create: organizationProcedure
        .input(v.object({ provider: v.picklist(["uncloud"]), image: imageReference }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [created] = await db
                .insert(sandboxImages)
                .values({ id: randomUUID(), organizationId, ...input })
                .onConflictDoNothing()
                .returning({ id: sandboxImages.id });

            if (!created)
                throw new ORPCError("CONFLICT", { message: "This image is already added." });

            return created;
        }),
    // Sandboxes keep a copy of their image, so removing one never touches them.
    remove: organizationProcedure
        .input(v.object({ imageId: id }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [removed] = await db
                .delete(sandboxImages)
                .where(
                    and(
                        eq(sandboxImages.id, input.imageId),
                        eq(sandboxImages.organizationId, organizationId),
                    ),
                )
                .returning({ id: sandboxImages.id });

            if (!removed) throw new ORPCError("NOT_FOUND", { message: "Image not found." });
        }),
};

export const sandboxesRouter = {
    images: imagesRouter,
    get: organizationProcedure
        .input(v.object(resourceInput))
        .handler(({ context: { db, organizationId }, input }) =>
            getSandbox(db, organizationId, input.projectId, input.resourceId),
        ),
    // What its next deploy would run, for the panel's `?showcompose=true` tab.
    compose: organizationProcedure
        .input(v.object(resourceInput))
        .handler(async ({ context: { db, organizationId }, input }) => {
            await getSandbox(db, organizationId, input.projectId, input.resourceId);

            const work = await getSandboxWork(db, input.resourceId);

            return {
                compose: work?.volume ? sandboxSpec(work.sandbox, work.volume.name) : null,
            };
        }),
    // Separate from `get` so the secret is only fetched when someone asks to see it.
    password: organizationProcedure
        .input(v.object(resourceInput))
        .handler(async ({ context: { db, organizationId }, input }) => {
            await getSandbox(db, organizationId, input.projectId, input.resourceId);

            const [row] = await db
                .select({ password: sandboxes.password })
                .from(sandboxes)
                .where(eq(sandboxes.resourceId, input.resourceId));

            return { password: row?.password ?? null };
        }),
    create: organizationProcedure
        .input(
            v.pipe(
                v.object({
                    projectId: id,
                    slug,
                    clusterId: id,
                    machine: v.optional(
                        v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(63)),
                    ),
                    imageId: id,
                    // A volume left by a destroyed sandbox; omitted creates a new one.
                    volumeId: v.optional(id),
                    authorizedKeys: v.optional(authorizedKeys),
                    password: v.optional(password),
                    ttlSeconds: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(60))),
                }),
                v.check(
                    (input) => Boolean(input.authorizedKeys || input.password),
                    "Add an SSH public key or a password.",
                ),
            ),
        )
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [project] = await editableProject(db, organizationId, input.projectId);

            if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found." });

            const [chosen] = await db
                .select({ image: sandboxImages.image })
                .from(sandboxImages)
                .where(
                    and(
                        eq(sandboxImages.id, input.imageId),
                        eq(sandboxImages.organizationId, organizationId),
                        eq(sandboxImages.provider, "uncloud"),
                    ),
                )
                .limit(1);

            if (!chosen) throw new ORPCError("NOT_FOUND", { message: "Image not found." });

            const volume = input.volumeId
                ? await getFreeVolume(db, input.clusterId, input.volumeId)
                : null;

            // Uncloud volumes live on one machine, so a reused one decides where the sandbox runs.
            if (volume?.machine && input.machine && volume.machine !== input.machine)
                throw new ORPCError("BAD_REQUEST", {
                    message: `This volume is on ${volume.machine}; pick that machine or none.`,
                });

            const check = () =>
                assertSlugFree(db, organizationId, input.clusterId, input.slug, volume?.id).then(
                    () => (volume ? getFreeVolume(db, input.clusterId, volume.id) : null),
                );

            await check();

            const image = await pinImageDigest(chosen.image).catch((error) => {
                throw new ORPCError("BAD_GATEWAY", {
                    message:
                        error instanceof Error ? error.message : "The registry is unreachable.",
                });
            });

            const resourceId = randomUUID();

            for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
                const sshPort = await freeSshPort(db, input.clusterId);

                try {
                    const deploymentId = await db.transaction(async (tx) => {
                        const volumeId = volume?.id ?? randomUUID();

                        await tx.insert(resources).values({
                            id: resourceId,
                            name: input.slug,
                            slug: resourceSlug(input.slug),
                            type: "sandbox",
                            projectId: project.id,
                        });

                        // Losing a race for the slug, port or volume inserts nothing.
                        if (!volume) {
                            const [added] = await tx
                                .insert(volumes)
                                .values({
                                    id: volumeId,
                                    clusterId: input.clusterId,
                                    name: `${sandboxServiceName(input.slug)}-data`,
                                })
                                .onConflictDoNothing()
                                .returning({ id: volumes.id });

                            if (!added) tx.rollback();
                        } else {
                            // Taking its card off the canvas claims the volume; a lost race finds it gone.
                            const [claimed] = await tx
                                .update(volumes)
                                .set({ resourceId: null })
                                .where(
                                    and(
                                        eq(volumes.id, volume.id),
                                        eq(volumes.resourceId, volume.card),
                                    ),
                                )
                                .returning({ id: volumes.id });

                            if (!claimed) tx.rollback();

                            await tx.delete(resources).where(eq(resources.id, volume.card));
                            await deleteEmptyGroups(tx, [volume.cardProjectId]);
                        }

                        const [created] = await tx
                            .insert(sandboxes)
                            .values({
                                resourceId,
                                organizationId,
                                slug: input.slug,
                                provider: "uncloud",
                                clusterId: input.clusterId,
                                machine: input.machine ?? volume?.machine ?? null,
                                sshPort,
                                volumeId,
                                image,
                                authorizedKeys: input.authorizedKeys || null,
                                password: input.password ?? null,
                                ttlSeconds: input.ttlSeconds ?? null,
                            })
                            .onConflictDoNothing()
                            .returning({ resourceId: sandboxes.resourceId });

                        if (!created) tx.rollback();

                        return queueSandboxDeployment(
                            tx,
                            resourceId,
                            input.clusterId,
                            "ProvisionSandbox",
                        );
                    });

                    return { id: resourceId, sshPort, deploymentId };
                } catch (error) {
                    if (!(error instanceof TransactionRollbackError)) throw error;
                }

                // Report a lost name or volume instead of retrying a port that was never the problem.
                await check();
            }

            throw new ORPCError("CONFLICT", {
                message: "Other sandboxes are taking this cluster's SSH ports. Try again.",
            });
        }),
    // Applied from the canvas like a bucket's removal: the job removes the VM, then the resource.
    destroy: organizationProcedure
        .input(v.object(resourceInput))
        .handler(({ context: { db, organizationId }, input }) =>
            request(
                db,
                organizationId,
                input.projectId,
                input.resourceId,
                ["provisioning", "running", "failed"],
                "DestroySandbox",
            ),
        ),
    // Repeats whichever attempt failed last: provisioning deploys again, destroying removes again.
    retry: organizationProcedure
        .input(v.object(resourceInput))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [latest] = await db
                .select({ name: deployments.name })
                .from(deployments)
                .where(eq(deployments.resourceId, input.resourceId))
                .orderBy(desc(deployments.createdAt))
                .limit(1);

            return request(
                db,
                organizationId,
                input.projectId,
                input.resourceId,
                ["failed"],
                latest?.name === "DestroySandbox" ? "DestroySandbox" : "ProvisionSandbox",
            );
        }),
};
