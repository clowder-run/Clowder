import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
// Imported, not defined here, so tests can swap the agent for one that trusts their own CA.
import { guardedHttpsAgent, isAllowedS3Address } from "./client";

// Registry manifests, tokens and S3 admin replies are a few KB; an image index stays well under this.
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type GuardedResponse = { status: number; headers: IncomingHttpHeaders; text: string };

/**
 * An HTTPS request to a user-supplied host under the same address policy: blocked IP literals are
 * refused, DNS is checked as the socket connects, and redirects are never followed.
 */
export function guardedHttpsRequest(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body = "",
) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");

    if (url.protocol !== "https:" || (isIP(hostname) && !isAllowedS3Address(hostname)))
        return Promise.reject(new Error(`${url.host} is not a permitted address.`));

    return new Promise<GuardedResponse>((resolve, reject) => {
        const request = httpsRequest(
            url,
            { method, headers, agent: guardedHttpsAgent(), timeout: 10_000 },
            (response) => {
                const chunks: Buffer[] = [];
                let size = 0;

                // The host is user-chosen, so an endless or huge body must not fill memory.
                response.on("data", (chunk: Buffer) => {
                    size += chunk.length;

                    if (size > MAX_RESPONSE_BYTES)
                        return request.destroy(new Error(`${url.host} sent too large a response.`));

                    chunks.push(chunk);
                });
                response.on("error", reject);
                response.on("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        text: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            },
        );

        request.on("timeout", () =>
            request.destroy(new Error(`${url.host} did not respond in time.`)),
        );
        request.on("error", reject);
        request.end(body);
    });
}
