import { once } from "node:events";
import { Agent, createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import * as s3Client from "@clowder/s3/client";
import { guardedHttpsRequest } from "@clowder/s3/guarded-request";
import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

describe("guardedHttpsRequest", () => {
    let server: Server;
    let url: URL;

    beforeAll(async () => {
        const pems = await generate([{ name: "commonName", value: "localhost" }], {
            keySize: 2048,
            extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }],
        });

        // Small replies end; `/endless` keeps sending until the client hangs up.
        server = createServer({ key: pems.private, cert: pems.cert }, (request, response) => {
            if (request.url !== "/endless") return response.end('{"token":"t"}');

            const chunk = Buffer.alloc(64 * 1024, "a");

            const write = () => {
                while (response.write(chunk));
            };

            response.on("drain", write);
            write();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");

        // SAFETY: a TCP server listening on a port always reports an AddressInfo.
        const { port } = server.address() as AddressInfo;

        url = new URL(`https://localhost:${port}`);
        // The production agent only reaches public addresses; this one trusts just the test certificate.
        vi.spyOn(s3Client, "guardedHttpsAgent").mockReturnValue(new Agent({ ca: pems.cert }));
    }, 30_000);

    afterAll(() => {
        vi.restoreAllMocks();
        server?.closeAllConnections();
        server?.close();
    });

    it("reads a small response", async () => {
        await expect(guardedHttpsRequest(new URL("/token", url), "GET", {})).resolves.toMatchObject(
            { status: 200, text: '{"token":"t"}' },
        );
    });

    it("stops reading a response past its size limit", async () => {
        await expect(guardedHttpsRequest(new URL("/endless", url), "GET", {})).rejects.toThrow(
            "too large a response",
        );
    });
});
