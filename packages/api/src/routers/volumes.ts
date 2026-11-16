import { ORPCError } from "@orpc/server";
import { deleteEmptyGroups } from "@clowder/db/groups";
import { clusters, projects, resources, volumes } from "@clowder/db/schema/index";
import { ucClient, UcApiError, unwrap } from "@clowder/uncloud";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import * as v from "valibot";

import { organizationProcedure, uncloudMiddleware } from "..";

const id = v.pipe(v.string(), v.uuid());

export const volumesRouter = {
    // Volume cards on a cluster, free for a new sandbox to mount.
    listUnused: organizationProcedure
        .input(v.object({ clusterId: id }))
        // Checks the cluster belongs to the organization and is set up.
        .use(uncloudMiddleware)
        .handler(({ context: { db }, input }) =>
            db
                .select({
                    id: volumes.id,
                    name: volumes.name,
                    machine: volumes.machine,
                    createdAt: volumes.createdAt,
                })
                .from(volumes)
                .where(and(eq(volumes.clusterId, input.clusterId), isNotNull(volumes.resourceId)))
                .orderBy(desc(volumes.createdAt)),
        ),

    // Deletes a volume card and its data, from every machine that has a volume by its name.
    remove: organizationProcedure
        .input(v.object({ projectId: id, resourceId: id }))
        .handler(({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const [volume] = await tx
                    .select({
                        id: volumes.id,
                        name: volumes.name,
                        sidecarUrl: clusters.sidecarUrl,
                        sidecarToken: clusters.sidecarToken,
                        sidecarCertificate: clusters.sidecarCertificate,
                    })
                    .from(volumes)
                    .innerJoin(resources, eq(resources.id, volumes.resourceId))
                    .innerJoin(projects, eq(projects.id, resources.projectId))
                    .innerJoin(clusters, eq(clusters.id, volumes.clusterId))
                    .where(
                        and(
                            eq(volumes.resourceId, input.resourceId),
                            eq(projects.id, input.projectId),
                            sql`${projects.isInternal} is not true`,
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    .for("update", { of: volumes });

                if (!volume) throw new ORPCError("NOT_FOUND", { message: "Volume not found." });

                const uc = ucClient(volume.sidecarUrl, {
                    token: volume.sidecarToken,
                    certificate: volume.sidecarCertificate,
                });

                const signal = AbortSignal.timeout(30_000);

                try {
                    const found = await unwrap(
                        uc.GET("/api/v1/volumes", {
                            params: { query: { names: volume.name } },
                            signal,
                        }),
                    );

                    // Never forced: Docker refuses a volume a container still uses.
                    for (const machine of new Set(found.items.map((item) => item.machineName))) {
                        await unwrap(
                            uc.DELETE("/api/v1/machines/{machine}/volumes/{volume}", {
                                params: { path: { machine, volume: volume.name } },
                                signal,
                            }),
                        ).catch((error) => {
                            // Already gone is what we wanted.
                            if (!(error instanceof UcApiError && error.status === 404)) throw error;
                        });
                    }
                } catch (error) {
                    throw new ORPCError("BAD_GATEWAY", {
                        message: `Could not delete "${volume.name}" from the cluster: ${
                            error instanceof Error ? error.message : "the sidecar did not respond"
                        }`,
                    });
                }

                await tx.delete(volumes).where(eq(volumes.id, volume.id));
                await tx.delete(resources).where(eq(resources.id, input.resourceId));
                await deleteEmptyGroups(tx, [input.projectId]);
            }),
        ),
};
