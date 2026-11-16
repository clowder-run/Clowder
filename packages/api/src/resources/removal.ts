import { ORPCError } from "@orpc/server";
import type { Database } from "@clowder/db";
import { deleteEmptyGroups } from "@clowder/db/groups";
import {
    clusters,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
    volumes,
} from "@clowder/db/schema/index";
import { ucClient, unwrap, type UcClient } from "@clowder/uncloud";
import { addVolumeCard } from "@clowder/db/volumes";
import { randomUUID } from "node:crypto";
import * as v from "valibot";
import YAML from "yaml";
import { prefixName, resourceComposePrefix, resourceEnv } from "@clowder/workflows/compose";
import { referencedResourceIds } from "@clowder/workflows/references";
import { snapshotServices } from "@clowder/workflows/stale-services";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";

type Resource = typeof resources.$inferSelect;

type Transaction = Pick<Database, "select" | "delete" | "insert" | "update">;

/** What a resource last put on the cluster: the Compose and prefix of its last deploy. */
async function lastDeploy(tx: Transaction, resource: Resource) {
    const [snapshot] = await tx
        .select({ spec: deployments.spec, prefix: resourceDeploymentInputs.prefix })
        .from(deployments)
        .leftJoin(
            resourceDeploymentInputs,
            eq(resourceDeploymentInputs.deploymentId, deployments.id),
        )
        .where(
            and(
                eq(deployments.resourceId, resource.id),
                eq(deployments.name, "DeployResource"),
                eq(deployments.status, "ready"),
            ),
        )
        .orderBy(desc(deployments.finishedAt), desc(deployments.createdAt))
        .limit(1);

    // Resources deployed before snapshots were kept still know their last published spec.
    return {
        spec: snapshot?.spec ?? resource.spec,
        prefix: snapshot?.prefix ?? resourceComposePrefix(resource) ?? "",
    };
}

const declaredVolumes = v.object({
    volumes: v.nullish(
        v.record(
            v.string(),
            v.nullish(v.object({ external: v.optional(v.any()), name: v.optional(v.string()) })),
        ),
    ),
});

/** A Compose file's top-level volumes; none when it doesn't parse. */
function composeVolumes(spec: string | null) {
    if (!spec?.trim()) return [];

    const parsed = v.safeParse(declaredVolumes, YAML.parseDocument(spec).toJS());

    return parsed.success ? Object.entries(parsed.output.volumes ?? {}) : [];
}

/**
 * The volumes a deploy created for this resource alone, by their names on the cluster. External and
 * `name:`-pinned ones may belong to another stack, so they are never claimed.
 */
function ownedVolumes(snapshot: { spec: string | null; prefix: string }) {
    // shortcut: with prefixes off, resources can share a volume name; claim none until that's tracked.
    if (!snapshot.prefix) return [];

    // A snapshot that doesn't parse was never deployed, so it created nothing.
    return composeVolumes(snapshot.spec).flatMap(([name, volume]) =>
        volume?.external || volume?.name ? [] : [prefixName(name, snapshot.prefix)],
    );
}

/** The machines that have each of `names`; a volume that never got created has none. */
async function existingVolumes(uc: UcClient, names: string[]) {
    const machines = new Map<string, string[]>();

    // One name per call: the items don't say which name they matched.
    for (const name of names) {
        const found = await unwrap(
            uc.GET("/api/v1/volumes", {
                params: { query: { names: name } },
                signal: AbortSignal.timeout(30_000),
            }),
        ).catch((error) => {
            throw new ORPCError("BAD_GATEWAY", {
                message: `Could not list the volumes to keep: ${error instanceof Error ? error.message : "the sidecar did not respond"}`,
            });
        });

        if (found.items.length)
            machines.set(
                name,
                found.items.map((item) => item.machineName),
            );
    }

    return machines;
}

/**
 * Deletes compose resources of one cluster, after removing their services from it. Refuses
 * while a resource is still deploying, is a bucket or sandbox (those clean up through their
 * own jobs), is a volume card, or is referenced by a resource that stays. Volumes are left on the
 * machines, so data is never destroyed as a side effect; with `keepVolumes`, the ones each resource
 * owned take its place on the canvas as cards, to be deleted from there. Callers lock the rows and
 * run this in a transaction; a failed removal leaves the rows, and a retry skips services that are
 * already gone.
 */
export async function removeResources(
    tx: Transaction,
    clusterId: string,
    removed: Resource[],
    keepVolumes = false,
) {
    if (!removed.length) return;
    const ids = removed.map((resource) => resource.id);
    const names = new Map(removed.map((resource) => [resource.id, resource.name]));

    const bucket = removed.find((resource) => resource.type === "bucket");

    if (bucket)
        throw new ORPCError("CONFLICT", {
            message: `Delete the S3 bucket "${bucket.name}" from its settings first.`,
        });

    // A sandbox's VM is removed by its own DestroySandbox job, which then deletes the resource.
    const sandbox = removed.find((resource) => resource.type === "sandbox");

    if (sandbox)
        throw new ORPCError("CONFLICT", {
            message: `Destroy the sandbox "${sandbox.name}" first.`,
        });

    // Deleting a volume card deletes its data, so it is never a side effect of removing something else.
    const volume = removed.find((resource) => resource.type === "volume");

    if (volume)
        throw new ORPCError("CONFLICT", { message: `Delete the volume "${volume.name}" first.` });

    const [active] = await tx
        .select({ resourceId: deployments.resourceId })
        .from(deployments)
        .where(
            and(
                inArray(deployments.resourceId, ids),
                inArray(deployments.status, ["queued", "running"]),
            ),
        )
        .limit(1);

    if (active)
        throw new ORPCError("CONFLICT", {
            message: `"${names.get(active.resourceId!)}" is deploying. Cancel or wait for the deployment first.`,
        });

    // Every other resource on the cluster that would be left with a dangling reference.
    const others = await tx
        .select({
            name: resources.name,
            settings: resources.settings,
            spec: resources.spec,
            draftSpec: resources.draftSpec,
        })
        .from(resources)
        .innerJoin(projects, eq(resources.projectId, projects.id))
        .where(
            and(
                eq(projects.clusterId, clusterId),
                notInArray(resources.id, ids),
                sql`${projects.isInternal} is not true`,
            ),
        );

    for (const other of others) {
        const target = referencedResourceIds(resourceEnv(other)).find((id) => names.has(id));

        if (target)
            throw new ORPCError("CONFLICT", {
                message: `"${other.name}" still references "${names.get(target)}". Remove the reference from its variables first.`,
            });
    }

    const [cluster] = await tx
        .select({
            sidecarUrl: clusters.sidecarUrl,
            sidecarToken: clusters.sidecarToken,
            sidecarCertificate: clusters.sidecarCertificate,
        })
        .from(clusters)
        .where(eq(clusters.id, clusterId))
        .limit(1);

    const uc = ucClient(cluster!.sidecarUrl, {
        token: cluster!.sidecarToken,
        certificate: cluster!.sidecarCertificate,
    });

    const deployed = [];

    for (const resource of removed)
        deployed.push({ resource, ...(await lastDeploy(tx, resource)) });

    // Asked before anything is removed, so an unreachable sidecar changes nothing.
    // A moved service keeps its volume by pinning the old name with `name:`; that volume is in use.
    const pinned = new Set(
        others.flatMap((other) =>
            [other.spec, other.draftSpec].flatMap((spec) =>
                composeVolumes(spec).flatMap(([, volume]) => (volume?.name ? [volume.name] : [])),
            ),
        ),
    );

    const kept = keepVolumes
        ? await existingVolumes(
              uc,
              deployed.flatMap(ownedVolumes).filter((name) => !pinned.has(name)),
          )
        : new Map<string, string[]>();

    for (const snapshot of deployed) {
        for (const service of snapshotServices(snapshot)) {
            const result = await uc
                .DELETE("/api/v1/services/{id}", {
                    params: { path: { id: service } },
                    signal: AbortSignal.timeout(30_000),
                })
                .catch(() => null);

            // Already gone is what we wanted.
            if (result && (result.response.ok || result.response.status === 404)) continue;

            const reason = result?.error?.error ?? "the sidecar did not respond";

            throw new ORPCError("BAD_GATEWAY", {
                message: `Could not remove service "${service}" from the cluster: ${reason}`,
            });
        }
    }

    await tx.delete(resources).where(inArray(resources.id, ids));

    for (const { resource, ...snapshot } of deployed) {
        for (const name of ownedVolumes(snapshot)) {
            const machines = kept.get(name);

            if (!machines) continue;

            // Already tracked, say by a card left from an earlier delete: nothing new to show.
            const [volume] = await tx
                .insert(volumes)
                .values({
                    id: randomUUID(),
                    clusterId,
                    name,
                    machine: machines.length === 1 ? machines[0] : null,
                })
                .onConflictDoNothing()
                .returning({ id: volumes.id });

            if (volume)
                await addVolumeCard(tx, resource.projectId, resource.groupId, volume.id, name);
        }
    }

    await deleteEmptyGroups(tx, [...new Set(removed.map((resource) => resource.projectId))]);
}
