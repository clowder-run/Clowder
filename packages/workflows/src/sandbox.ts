import type { Database } from "@clowder/db";
import { appendDeploymentLog, setDeploymentStatus } from "@clowder/db/deployments";
import {
    getSandboxWork,
    deleteSandboxResource,
    markSandboxFailed,
    markSandboxRunning,
    SANDBOX_DATA,
    sandboxServiceName,
    setSandboxVolumeMachine,
    type SandboxDeploymentName,
    type SandboxRow,
} from "@clowder/db/sandboxes";
import { ucClient, UcApiError, unwrap, type UcClient } from "@clowder/uncloud";
import { stringify } from "yaml";
import { deployCompose } from "./deploy-compose";

type Work = NonNullable<Awaited<ReturnType<typeof getSandboxWork>>>;

type Log = (text: string, level?: "info" | "debug" | "error", event?: string) => Promise<void>;

// Compose interpolates `$`, so a literal one is written `$$`.
function literal(value: string) {
    return value.replaceAll("$", "$$");
}

/** The Compose file that runs a sandbox's microVM on Uncloud. */
export function sandboxCompose(sandbox: SandboxRow, volume: string) {
    // `stringify` drops undefined values, so unset options leave no key behind.
    const service = {
        image: sandbox.image,
        environment: {
            SANDBOX_HOSTNAME: sandbox.slug,
            SSH_AUTHORIZED_KEYS: sandbox.authorizedKeys
                ? literal(sandbox.authorizedKeys)
                : undefined,
            SANDBOX_PASSWORD: sandbox.password ? literal(sandbox.password) : undefined,
            SANDBOX_TTL_SECONDS: sandbox.ttlSeconds ? String(sandbox.ttlSeconds) : undefined,
        },
        devices: ["/dev/kvm:/dev/kvm", "/dev/net/tun:/dev/net/tun"],
        cap_add: ["NET_ADMIN"],
        sysctls: { "net.ipv4.ip_forward": "1" },
        volumes: [`${volume}:${SANDBOX_DATA}`],
        "x-ports": [`${sandbox.sshPort}:22/tcp@host`],
        "x-machines": sandbox.machine ?? undefined,
    };

    return stringify({
        services: { [sandboxServiceName(sandbox.slug)]: service },
        volumes: { [volume]: {} },
    });
}

/** The Compose file as Clowder shows it, in deployments and the panel: the password stays hidden. */
export function sandboxSpec(sandbox: SandboxRow, volume: string) {
    return sandboxCompose({ ...sandbox, password: sandbox.password && "********" }, volume);
}

// Where users SSH to: the public IP, else the address its WireGuard endpoint advertises.
async function machineAddress(uc: UcClient, machine: string, signal: AbortSignal) {
    const machines = await unwrap(uc.GET("/api/v1/machines", { signal }));
    const found = machines.items.find((item) => item.name === machine);
    const endpoint = found?.network?.endpoints[0];

    return (
        found?.publicIp ??
        (endpoint ? endpoint.replace(/:\d+$/u, "").replace(/^\[|\]$/gu, "") : null)
    );
}

// A sandbox that never deployed, or a retry after removal, has nothing left to remove.
async function removeService(uc: UcClient, service: string, signal: AbortSignal) {
    await unwrap(
        uc.DELETE("/api/v1/services/{id}", { params: { path: { id: service } }, signal }),
    ).catch((error) => {
        if (!(error instanceof UcApiError && error.status === 404)) throw error;
    });
}

/**
 * Runs one attempt as its deployment, like AddMachine: claims the row, writes every line to
 * its log, then settles both the deployment and the sandbox.
 */
async function runAttempt(
    db: Database,
    deploymentId: string,
    name: SandboxDeploymentName,
    signal: AbortSignal,
    work: (sandbox: Work, uc: UcClient, log: Log) => Promise<void>,
) {
    const claimed = await db.$client.query<{ resourceId: string | null }>(
        `UPDATE deployments SET status = 'running', error = NULL, finished_at = NULL, updated_at = now()
         WHERE id = $1 AND name = $2 AND status IN ('queued', 'running')
         RETURNING resource_id AS "resourceId"`,
        [deploymentId, name],
    );

    // Cancelled, settled or deleted since it was queued.
    const resourceId = claimed.rows[0]?.resourceId;

    if (!resourceId) return;

    // Status lines carry no event, so the timeline shows them as notes like a resource deploy.
    const log = (text: string, level: "info" | "debug" | "error" = "info", event?: string) =>
        appendDeploymentLog(db, deploymentId, text, { level, event }).catch(() => {});

    try {
        const found = await getSandboxWork(db, resourceId);

        if (!found) throw new Error("The sandbox no longer exists.");

        const uc = ucClient(found.cluster.sidecarUrl, {
            token: found.cluster.sidecarToken,
            certificate: found.cluster.sidecarCertificate,
        });

        await work(found, uc, log);
        await setDeploymentStatus(db, deploymentId, "ready");
    } catch (error) {
        // Interruption is not a failure: the job is released and runs again.
        if (signal.aborted) throw error;

        const message = error instanceof Error ? error.message : `${name} failed.`;

        await log(message, "error", "error");
        await setDeploymentStatus(db, deploymentId, "failed", message);
        await markSandboxFailed(db, resourceId);

        throw new Error(message);
    }
}

export function provisionSandbox(db: Database, deploymentId: string, signal: AbortSignal) {
    return runAttempt(db, deploymentId, "ProvisionSandbox", signal, async (work, uc, log) => {
        const { sandbox, cluster, volume } = work;
        const service = sandboxServiceName(sandbox.slug);

        if (!volume)
            throw new Error("The sandbox's volume is gone. Destroy it and create a new one.");

        // What the deployment's "View spec" shows.
        await db.$client.query("UPDATE deployments SET spec = $2 WHERE id = $1", [
            deploymentId,
            sandboxSpec(sandbox, volume.name),
        ]);
        await log(`Deploying ${service} to ${cluster.name}.`);
        await deployCompose(
            uc,
            sandboxCompose(sandbox, volume.name),
            signal,
            log,
            [service],
            sandbox.password ? [sandbox.password] : [],
            async (percent) => {
                await db.$client.query(
                    "UPDATE deployments SET progress = $2 WHERE id = $1 AND status = 'running' AND progress < $2",
                    [deploymentId, percent],
                );
            },
        );

        // The VM already runs, so a failed lookup only costs the SSH address, not the sandbox.
        const host = await unwrap(
            uc.GET("/api/v1/volumes", { params: { query: { names: volume.name } }, signal }),
        )
            .then(async (volumes) => {
                const machine = volumes.items[0]?.machineName;

                if (!machine) return null;

                await setSandboxVolumeMachine(db, volume.id, machine);

                return machineAddress(uc, machine, signal);
            })
            .catch(async (error) => {
                signal.throwIfAborted();
                await log(
                    `Couldn't look up where it runs: ${error instanceof Error ? error.message : error}`,
                    "error",
                );

                return null;
            });

        if (await markSandboxRunning(db, sandbox.resourceId, host)) {
            await log(
                host
                    ? `SSH is open at ${host}:${sandbox.sshPort}.`
                    : `SSH is open on port ${sandbox.sshPort}.`,
            );

            return;
        }

        // Destroyed while this deploy ran: its removal may have come first, so this VM is nobody's.
        await removeService(uc, service, signal);
        await log("The sandbox was destroyed meanwhile, so its VM was removed again.");
    });
}

export function destroySandbox(db: Database, deploymentId: string, signal: AbortSignal) {
    return runAttempt(db, deploymentId, "DestroySandbox", signal, async ({ sandbox }, uc, log) => {
        const service = sandboxServiceName(sandbox.slug);

        await log(`Removing ${service}.`);
        await removeService(uc, service, signal);
        await log("Removed. Its volume was kept for reuse.");
        await deleteSandboxResource(db, sandbox.resourceId);
    });
}
