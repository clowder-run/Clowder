import { eq } from "drizzle-orm";
import type { Database } from "./index";
import { resources, volumes } from "./schema";

type Transaction = Pick<Database, "insert" | "update">;

/** Puts a volume nothing uses on the canvas as a card of its own, where its owner's card was. */
export async function addVolumeCard(
    tx: Transaction,
    projectId: string,
    groupId: string | null,
    volumeId: string,
    name: string,
) {
    const resourceId = crypto.randomUUID();

    await tx.insert(resources).values({ id: resourceId, name, type: "volume", projectId, groupId });
    await tx.update(volumes).set({ resourceId }).where(eq(volumes.id, volumeId));
}
