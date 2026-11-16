import { and, eq, inArray, isNull } from "drizzle-orm";
import { deleteEmptyGroups } from "./groups";
import type { Database } from "./index";
import { clusters, deployments, resources, sandboxes, type SandboxStatus, volumes } from "./schema";
import { addVolumeCard } from "./volumes";

// The prefix keeps a sandbox from ever taking over a resource's or Clowder's own service or volume.
export const SANDBOX_PREFIX = "sandbox-";

/** The Uncloud service a sandbox runs as; its volume adds `-data`. The VM's hostname is the bare slug. */
export function sandboxServiceName(slug: string) {
    return `${SANDBOX_PREFIX}${slug}`;
}

/** Where the VM's volume is mounted in its container. */
export const SANDBOX_DATA = "/var/lib/sandbox";

export type SandboxDeploymentName = "ProvisionSandbox" | "DestroySandbox";

export type SandboxRow = typeof sandboxes.$inferSelect;

/**
 * A queued attempt, as a deployment of the sandbox's resource, so the canvas shows it like any
 * other. The row is the outbox: the worker's sweep picks it up.
 */
export async function queueSandboxDeployment(
    db: Pick<Database, "insert">,
    resourceId: string,
    clusterId: string,
    name: SandboxDeploymentName,
) {
    const id = crypto.randomUUID();

    await db
        .insert(deployments)
        .values({ id, jobId: id, clusterId, resourceId, name, status: "queued" });

    return id;
}

export async function getSandboxWork(db: Database, resourceId: string) {
    const [row] = await db
        .select({ sandbox: sandboxes, cluster: clusters, volume: volumes })
        .from(sandboxes)
        .innerJoin(clusters, eq(sandboxes.clusterId, clusters.id))
        .leftJoin(volumes, eq(sandboxes.volumeId, volumes.id))
        .where(eq(sandboxes.resourceId, resourceId))
        .limit(1);

    return row ?? null;
}

// Each write only moves on from the state its job was started for, so a destroy requested
// mid-deploy is never overwritten by the deploy finishing.
async function moveSandbox(
    db: Database,
    resourceId: string,
    from: SandboxStatus[],
    values: Partial<typeof sandboxes.$inferInsert>,
) {
    const updated = await db
        .update(sandboxes)
        .set(values)
        .where(and(eq(sandboxes.resourceId, resourceId), inArray(sandboxes.status, from)))
        .returning({ resourceId: sandboxes.resourceId });

    return updated.length > 0;
}

export function markSandboxRunning(db: Database, resourceId: string, sshHost: string | null) {
    return moveSandbox(db, resourceId, ["provisioning"], { status: "running", sshHost });
}

/**
 * Its deployment carries why; a retry repeats whichever attempt failed. Only the state `name`
 * was started for moves, so a failed deploy never takes over a destroy requested meanwhile.
 */
export function markSandboxFailed(db: Database, resourceId: string, name: SandboxDeploymentName) {
    return moveSandbox(
        db,
        resourceId,
        [name === "ProvisionSandbox" ? "provisioning" : "destroying"],
        {
            status: "failed",
        },
    );
}

/**
 * Whether a ProvisionSandbox attempt is still deploying the sandbox. A queued one is cancelled
 * instead, so it never starts; its claim and this update can't both win.
 */
export async function provisioningRunning(db: Database, resourceId: string) {
    const active = and(
        eq(deployments.resourceId, resourceId),
        eq(deployments.name, "ProvisionSandbox" satisfies SandboxDeploymentName),
    );

    await db
        .update(deployments)
        .set({ status: "cancelled", error: "The sandbox was destroyed.", finishedAt: new Date() })
        .where(and(active, eq(deployments.status, "queued")));

    const [running] = await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(active, eq(deployments.status, "running")))
        .limit(1);

    return Boolean(running);
}

/**
 * Removes a destroyed sandbox from its project, like a deleted bucket. Its volume stays on the
 * machines and takes its place on the canvas, until it's reused or deleted.
 */
export async function deleteSandboxResource(db: Database, resourceId: string) {
    await db.transaction(async (tx) => {
        const [locked] = await tx
            .select({
                projectId: resources.projectId,
                groupId: resources.groupId,
                volume: { id: volumes.id, name: volumes.name },
            })
            .from(sandboxes)
            .innerJoin(resources, eq(resources.id, sandboxes.resourceId))
            .leftJoin(volumes, eq(volumes.id, sandboxes.volumeId))
            .where(and(eq(sandboxes.resourceId, resourceId), eq(sandboxes.status, "destroying")))
            .for("update", { of: sandboxes });

        if (!locked) return;

        if (locked.volume)
            await addVolumeCard(
                tx,
                locked.projectId,
                locked.groupId,
                locked.volume.id,
                locked.volume.name,
            );

        await tx.delete(resources).where(eq(resources.id, resourceId));
        await deleteEmptyGroups(tx, [locked.projectId]);
    });
}

// Uncloud places a new volume with its first container; later sandboxes must follow it there.
export async function setSandboxVolumeMachine(db: Database, volumeId: string, machine: string) {
    await db
        .update(volumes)
        .set({ machine })
        .where(and(eq(volumes.id, volumeId), isNull(volumes.machine)));
}
