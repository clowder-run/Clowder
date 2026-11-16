import { guardedHttpsRequest, type GuardedResponse } from "@clowder/s3/guarded-request";
import * as v from "valibot";
import { parseImageReference } from "./image-reference";

// Index types first, so a multi-platform tag pins the index and each machine pulls its own platform.
const MANIFEST_TYPES = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

const tokenSchema = v.union([
    v.object({ token: v.string() }),
    v.object({ access_token: v.string() }),
]);

// Registries are user input, so they get the S3 endpoint address policy.
function send(url: URL, method: "GET" | "HEAD", headers: Record<string, string>) {
    return guardedHttpsRequest(url, method, headers).catch(() => {
        throw new Error(`Couldn't reach ${url.host}.`);
    });
}

function header(response: GuardedResponse, name: string) {
    const value = response.headers[name];

    return Array.isArray(value) ? value[0] : value;
}

/** Where to fetch an anonymous token for a registry's `Bearer realm=...` challenge. */
export function tokenUrl(challenge: string) {
    const params = new Map(
        Array.from(challenge.matchAll(/(\w+)="([^"]*)"/gu), ([, key, value]) => [key, value]),
    );

    const realm = params.get("realm");

    if (!challenge.startsWith("Bearer ") || !realm?.startsWith("https://"))
        throw new Error("The registry asked for credentials. Only public images are supported.");

    const url = new URL(realm);

    for (const key of ["service", "scope"]) {
        const value = params.get(key);

        if (value) url.searchParams.set(key, value);
    }

    return url;
}

async function anonymousToken(challenge: string) {
    const response = await send(tokenUrl(challenge), "GET", {});

    if (response.status !== 200)
        throw new Error(`The registry refused an anonymous token (${response.status}).`);

    const body = v.parse(tokenSchema, JSON.parse(response.text));

    return "token" in body ? body.token : body.access_token;
}

/**
 * Pins a public image to the digest its tag points at now, as `name:tag@sha256:...`.
 * An image that already names a digest is returned as is.
 */
export async function pinImageDigest(image: string) {
    const reference = parseImageReference(image);

    if (!reference) throw new Error(`${image} is not a valid image reference.`);

    if (reference.digest) return image;

    const url = new URL(
        `https://${reference.registry}/v2/${reference.repository}/manifests/${reference.tag}`,
    );

    const head = (token: string | null) =>
        send(
            url,
            "HEAD",
            token
                ? { Accept: MANIFEST_TYPES, Authorization: `Bearer ${token}` }
                : { Accept: MANIFEST_TYPES },
        );

    let response = await head(null);
    const challenge = header(response, "www-authenticate");

    if (response.status === 401 && challenge)
        response = await head(await anonymousToken(challenge));

    if (response.status === 404) throw new Error(`${image} was not found in its registry.`);

    if (response.status !== 200)
        throw new Error(`The registry answered ${response.status} for ${image}.`);

    // shortcut: assumes the registry returns the digest on HEAD, as Docker Hub, GHCR and Zot do;
    // hash a GET of the manifest if one doesn't.
    const digest = header(response, "docker-content-digest");

    if (!digest || !DIGEST.test(digest))
        throw new Error(`The registry did not return a digest for ${image}.`);

    return `${reference.name}:${reference.tag}@${digest}`;
}
