import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshKeyPair } from "@clowder/workflows/ssh-key";
import { describe, expect, it } from "vite-plus/test";

const hasSshKeygen = !spawnSync("ssh-keygen", ["-?"]).error;

describe("sshKeyPair", () => {
    it.skipIf(!hasSshKeygen)(
        "makes a private key OpenSSH reads back to its public key",
        async () => {
            const { publicKey, privateKey } = await sshKeyPair("clowder-test");
            const dir = await mkdtemp(join(tmpdir(), "clowder-ssh-key-"));
            const file = join(dir, "id_ed25519");

            try {
                await writeFile(file, privateKey, { mode: 0o600 });

                const derived = spawnSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" });

                // The key carries its comment, so OpenSSH derives the whole public key line.
                expect(derived.stdout.trim()).toBe(publicKey);
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
    );

    it("comments the public key", async () => {
        expect((await sshKeyPair("clowder-abc")).publicKey).toMatch(
            /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA[\w+/]+=* clowder-abc$/u,
        );
    });
});
