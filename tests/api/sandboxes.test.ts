import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@clowder/db";
import { deleteSandboxResource } from "@clowder/db/sandboxes";
import { clusters, deployments, projects, resources, sandboxes } from "@clowder/db/schema/index";
import { and, desc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { pinImageDigest, platformDigest, tokenUrl } from "../../packages/api/src/registry";
import { sandboxesRouter } from "../../packages/api/src/routers/sandboxes";
import { volumesRouter } from "../../packages/api/src/routers/volumes";
import { clusterRouter } from "../../packages/api/src/routers/cluster";
import { projectsRouter } from "../../packages/api/src/routers/projects";
import { insertUserWithOrganization } from "../users";

const DIGEST = `sha256:${"a".repeat(64)}`;

// Already pinned, so creating sandboxes never reaches a registry.
const IMAGE = `pkg.bar/sandbox:latest@${DIGEST}`;

describe("registry", () => {
    it("keeps an image that already names a digest", async () => {
        await expect(pinImageDigest(IMAGE)).resolves.toBe(IMAGE);
    });

    it("sizes the linux/amd64 image of an index, skipping attestations", () => {
        const amd64 = `sha256:${"b".repeat(64)}`;

        expect(
            platformDigest({
                manifests: [
                    {
                        digest: `sha256:${"c".repeat(64)}`,
                        platform: { os: "linux", architecture: "arm64" },
                    },
                    {
                        digest: `sha256:${"d".repeat(64)}`,
                        platform: { os: "unknown", architecture: "unknown" },
                    },
                    { digest: amd64, platform: { os: "linux", architecture: "amd64" } },
                ],
            }),
        ).toBe(amd64);
        expect(
            platformDigest({
                manifests: [
                    { digest: "../../etc", platform: { os: "linux", architecture: "amd64" } },
                ],
            }),
        ).toBeNull();
        expect(
            platformDigest({
                manifests: [
                    { digest: amd64, platform: { os: "unknown", architecture: "unknown" } },
                ],
            }),
        ).toBeNull();
    });

    it("asks a Bearer challenge's realm for an anonymous token", () => {
        expect(
            tokenUrl(
                'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/ubuntu:pull"',
            ).toString(),
        ).toBe(
            "https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fubuntu%3Apull",
        );
    });

    it.each(['Basic realm="private"', 'Bearer realm="http://auth.example.test/token"'])(
        "refuses the challenge %s",
        (challenge) => {
            expect(() => tokenUrl(challenge)).toThrow("Only public images are supported.");
        },
    );

    it.each(["localhost:5000/app", "127.0.0.1:5000/app", "169.254.169.254/app"])(
        "never connects to the internal registry %s",
        async (image) => {
            await expect(pinImageDigest(image)).rejects.toThrow(/not an allowed registry|reach/u);
        },
    );
});

describe("sandboxes API", () => {
    const databaseName = `clowder_sandboxes_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    const publicKey = `ssh-ed25519 ${"A".repeat(68)} me@laptop`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let owner: Context;
    let stranger: Context;
    let imageId: string;
    let organizationId: string;

    function context(userId: string, organizationId: string) {
        // SAFETY: authorization reads only identity and active organization.
        return {
            db,
            session: { user: { id: userId }, session: { activeOrganizationId: organizationId } },
        } as Context;
    }

    function create(slug: string, extra: Record<string, string> = {}) {
        return call(
            sandboxesRouter.create,
            { projectId, slug, clusterId, imageId, authorizedKeys: publicKey, ...extra },
            { context: owner },
        );
    }

    beforeAll(async () => {
        vi.stubEnv("APP_SECRET", "sandbox-integration-test-secret-at-least-32-bytes");
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        organizationId = await insertUserWithOrganization(db, "owner", "Owner", "o@x.test");

        const otherOrganization = await insertUserWithOrganization(
            db,
            "other",
            "Other",
            "s@x.test",
        );

        owner = context("owner", organizationId);
        stranger = context("other", otherOrganization);
        await db.insert(clusters).values({
            id: clusterId,
            name: "Cluster",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
            organizationId,
        });
        await db.insert(projects).values({ id: projectId, name: "Project", clusterId });
        ({ id: imageId } = await call(
            sandboxesRouter.images.create,
            { provider: "uncloud", image: IMAGE },
            { context: owner },
        ));
    }, 30_000);

    afterAll(async () => {
        vi.unstubAllEnvs();
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    it("keeps images per organization and refuses duplicates", async () => {
        await expect(
            call(
                sandboxesRouter.images.create,
                { provider: "uncloud", image: IMAGE },
                { context: owner },
            ),
        ).rejects.toThrow("already added");
        expect(await call(sandboxesRouter.images.list, undefined, { context: stranger })).toEqual(
            [],
        );
    });

    function sandboxInput(resourceId: string) {
        return { projectId, resourceId };
    }

    function attempts(resourceId: string) {
        return db
            .select({ name: deployments.name, status: deployments.status })
            .from(deployments)
            .where(eq(deployments.resourceId, resourceId))
            .orderBy(desc(deployments.createdAt));
    }

    it("creates a pinned sandbox resource with its own volume, port and queued attempt", async () => {
        const { id, sshPort } = await create("brave-otter");
        const sandbox = await call(sandboxesRouter.get, sandboxInput(id), { context: owner });
        const [resource] = await db.select().from(resources).where(eq(resources.id, id));

        expect(resource).toMatchObject({ type: "sandbox", name: "brave-otter", projectId });
        expect(sshPort).toBe(30000);
        expect(sandbox).toMatchObject({
            slug: "brave-otter",
            status: "provisioning",
            image: IMAGE,
            authorizedKeys: publicKey,
            hasPassword: false,
        });
        expect(await attempts(id)).toEqual([{ name: "ProvisionSandbox", status: "queued" }]);
        expect((await create("calm-fox", { password: randomUUID() })).sshPort).toBe(30001);
    });

    it("refuses a taken slug, a dotted slug and a sandbox without a login", async () => {
        await expect(create("brave-otter")).rejects.toThrow("That name is taken.");
        await expect(create("brave.otter")).rejects.toThrow();
        await expect(
            call(
                sandboxesRouter.create,
                { projectId, slug: "no-login", clusterId, imageId },
                { context: owner },
            ),
        ).rejects.toThrow();
    });

    it("shows its Compose without the password", async () => {
        const password = randomUUID();
        const { id } = await create("loud-crane", { password });

        const { compose } = await call(sandboxesRouter.compose, sandboxInput(id), {
            context: owner,
        });

        expect(compose).toContain("sandbox-loud-crane:");
        expect(compose).toContain('SANDBOX_PASSWORD: "********"');
        expect(compose).not.toContain(password);
    });

    it("shows the password only through its own call", async () => {
        const password = randomUUID();
        const { id } = await create("quiet-heron", { password });

        expect(
            JSON.stringify(await call(sandboxesRouter.get, sandboxInput(id), { context: owner })),
        ).not.toContain(password);
        expect(await call(sandboxesRouter.password, sandboxInput(id), { context: owner })).toEqual({
            password,
        });
        await expect(
            call(sandboxesRouter.password, sandboxInput(id), { context: stranger }),
        ).rejects.toThrow("Sandbox not found.");
    });

    it("keeps a destroyed sandbox's volume and port free for a new one", async () => {
        const { id, sshPort } = await create("old-badger");

        // Staged on the canvas, then applied: an accepted destroy is no longer a change to apply.
        await db.update(resources).set({ pendingDelete: true }).where(eq(resources.id, id));
        await call(sandboxesRouter.destroy, sandboxInput(id), { context: owner });
        expect((await attempts(id))[0]).toMatchObject({ name: "DestroySandbox" });
        expect(
            (await db.select().from(resources).where(eq(resources.id, id)))[0]?.pendingDelete,
        ).toBe(false);
        await expect(
            call(sandboxesRouter.destroy, sandboxInput(id), { context: owner }),
        ).rejects.toThrow("This sandbox is destroying.");

        // What the DestroySandbox job does once the service is gone.
        await deleteSandboxResource(db, id);

        const [volume] = await call(volumesRouter.listUnused, { clusterId }, { context: owner });

        expect(volume?.name).toBe("sandbox-old-badger-data");
        // The kept volume holds on to its name until it's reused.
        await expect(create("old-badger")).rejects.toThrow("Pick it as the volume");

        // Picking it, as the error says, takes the name back.
        const reused = await create("old-badger", { volumeId: volume!.id });

        const [card] = await db
            .select({ id: resources.id })
            .from(resources)
            .where(and(eq(resources.projectId, projectId), eq(resources.name, volume!.name)));

        // Mounted again, the volume is a tray of the new sandbox instead of a card.
        expect(card).toBeUndefined();

        expect(reused.sshPort).toBe(sshPort);
        await expect(create("third-badger", { volumeId: volume!.id })).rejects.toThrow(
            "Another sandbox is using this volume.",
        );
    });

    it("retries whichever attempt failed, and only on a failed sandbox", async () => {
        const { id } = await create("shy-lynx");

        await expect(
            call(sandboxesRouter.retry, sandboxInput(id), { context: owner }),
        ).rejects.toThrow("This sandbox is provisioning.");

        await db.update(sandboxes).set({ status: "failed" }).where(eq(sandboxes.resourceId, id));
        await call(sandboxesRouter.retry, sandboxInput(id), { context: owner });
        expect((await attempts(id)).map((row) => row.name)).toEqual([
            "ProvisionSandbox",
            "ProvisionSandbox",
        ]);

        // A failed destroy is retried as a destroy.
        await call(sandboxesRouter.destroy, sandboxInput(id), { context: owner });
        await db.update(sandboxes).set({ status: "failed" }).where(eq(sandboxes.resourceId, id));
        await call(sandboxesRouter.retry, sandboxInput(id), { context: owner });
        expect((await attempts(id))[0]).toMatchObject({ name: "DestroySandbox" });
    });

    it("refuses to delete a project or cluster that still has sandboxes", async () => {
        await expect(
            call(projectsRouter.deleteProject, { projectId }, { context: owner }),
        ).rejects.toThrow(/Destroy the sandbox ".+" first\./u);
        await expect(
            call(clusterRouter.deleteCluster, { clusterId }, { context: owner }),
        ).rejects.toThrow("Destroy the sandboxes on this cluster first.");
    });

    it("refuses to delete the cluster of a project whose sandbox runs elsewhere", async () => {
        const homeId = randomUUID();
        const homeProjectId = randomUUID();

        await db.insert(clusters).values({
            id: homeId,
            name: "Home",
            sidecarUrl: "http://home.test",
            sidecarToken: "secret",
            organizationId,
        });
        await db.insert(projects).values({ id: homeProjectId, name: "Home", clusterId: homeId });
        await call(
            sandboxesRouter.create,
            {
                projectId: homeProjectId,
                slug: "far-wren",
                clusterId,
                imageId,
                authorizedKeys: publicKey,
            },
            { context: owner },
        );

        await expect(
            call(clusterRouter.deleteCluster, { clusterId: homeId }, { context: owner }),
        ).rejects.toThrow("Destroy the sandboxes on this cluster first.");
    });
});
