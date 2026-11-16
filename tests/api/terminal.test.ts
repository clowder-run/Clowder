import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@clowder/db";
import { clusters, projects, resources } from "@clowder/db/schema/index";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { sandboxesRouter } from "../../packages/api/src/routers/sandboxes";
import { terminalRouter } from "../../packages/api/src/routers/terminal";
import { insertUserWithOrganization } from "../users";

const IMAGE = `pkg.bar/sandbox:latest@sha256:${"a".repeat(64)}`;

describe("terminal API", () => {
    const databaseName = `clowder_terminal_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    const resourceId = randomUUID();
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let owner: Context;
    let stranger: Context;

    function context(userId: string, organizationId: string) {
        // SAFETY: authorization reads only identity and active organization.
        return {
            db,
            session: { user: { id: userId }, session: { activeOrganizationId: organizationId } },
        } as Context;
    }

    // The first event is where a refused shell fails.
    async function open(as: Context, target: string, service?: string) {
        const events = await call(
            terminalRouter.open,
            { projectId, resourceId: target, service, cols: 80, rows: 24 },
            { context: as },
        );

        return events.next();
    }

    beforeAll(async () => {
        vi.stubEnv("APP_SECRET", "terminal-integration-test-secret-at-least-32-bytes");
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        const organizationId = await insertUserWithOrganization(db, "owner", "Owner", "o@x.test");
        const other = await insertUserWithOrganization(db, "other", "Other", "s@x.test");

        owner = context("owner", organizationId);
        stranger = context("other", other);
        await db.insert(clusters).values({
            id: clusterId,
            name: "Cluster",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
            organizationId,
        });
        await db.insert(projects).values({ id: projectId, name: "Project", clusterId });
        await db.insert(resources).values({
            id: resourceId,
            projectId,
            name: "Web",
            spec: "services:\n  web:\n    image: nginx\n",
        });
    }, 30_000);

    afterAll(async () => {
        vi.unstubAllEnvs();
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    it("never opens a shell in a service outside the resource", async () => {
        await expect(open(owner, resourceId, "sidecar")).rejects.toThrow(
            "This resource has no service to open a shell in.",
        );
    });

    it("never opens a shell in Clowder's own services, even when a resource names one", async () => {
        const unprefixed = randomUUID();

        await db.insert(resources).values({
            id: unprefixed,
            projectId,
            name: "Sneaky",
            spec: "services:\n  sidecar:\n    image: nginx\n",
            settings: { prefixNames: false },
        });

        await expect(open(owner, unprefixed, "sidecar")).rejects.toThrow(
            "This resource has no service to open a shell in.",
        );
    });

    it("keeps other organizations out", async () => {
        await expect(open(stranger, resourceId, "web")).rejects.toThrow("Project not found.");
    });

    it("explains that a sandbox without a password can't be opened", async () => {
        const { id: imageId } = await call(
            sandboxesRouter.images.create,
            { provider: "uncloud", image: IMAGE },
            { context: owner },
        );

        const { id } = await call(
            sandboxesRouter.create,
            {
                projectId,
                slug: "brave-otter",
                clusterId,
                imageId,
                authorizedKeys: `ssh-ed25519 ${"A".repeat(68)} me@laptop`,
            },
            { context: owner },
        );

        await expect(open(owner, id)).rejects.toThrow("only accepts SSH keys");
    });

    it("only takes input for an open shell", async () => {
        await expect(
            call(terminalRouter.send, { id: randomUUID(), data: "ls\n" }, { context: owner }),
        ).rejects.toThrow("This terminal has closed.");
    });
});
