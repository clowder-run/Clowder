import { guardedHttpsRequest, type GuardedResponse } from "@clowder/s3/guarded-request";
import * as v from "valibot";
import { dockerHubImageSize } from "./docker-hub";
import { DOCKER_HUB, parseImageReference, type ImageReference } from "./image-reference";

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

/** Requests `image`'s manifests by tag or digest, fetching an anonymous token once when asked. */
function manifests(image: string, reference: ImageReference) {
    let token: string | null = null;

    return async (method: "GET" | "HEAD", tagOrDigest: string) => {
        const url = new URL(
            `https://${reference.registry}/v2/${reference.repository}/manifests/${tagOrDigest}`,
        );

        const request = () =>
            send(
                url,
                method,
                token
                    ? { Accept: MANIFEST_TYPES, Authorization: `Bearer ${token}` }
                    : { Accept: MANIFEST_TYPES },
            );

        let response = await request();
        const challenge = header(response, "www-authenticate");

        if (response.status === 401 && challenge && !token) {
            token = await anonymousToken(challenge);
            response = await request();
        }

        if (response.status === 404) throw new Error(`${image} was not found in its registry.`);

        if (response.status !== 200)
            throw new Error(`The registry answered ${response.status} for ${image}.`);

        return response;
    };
}

/**
 * Pins a public image to the digest its tag points at now, as `name:tag@sha256:...`.
 * An image that already names a digest is returned as is.
 */
export async function pinImageDigest(image: string) {
    const reference = parseImageReference(image);

    if (!reference) throw new Error(`${image} is not a valid image reference.`);

    if (reference.digest) return image;

    const response = await manifests(image, reference)("HEAD", reference.tag);

    // shortcut: assumes the registry returns the digest on HEAD, as Docker Hub, GHCR and Zot do;
    // hash a GET of the manifest if one doesn't.
    const digest = header(response, "docker-content-digest");

    if (!digest || !DIGEST.test(digest))
        throw new Error(`The registry did not return a digest for ${image}.`);

    return `${reference.name}:${reference.tag}@${digest}`;
}

const indexSchema = v.object({
    manifests: v.array(
        v.object({
            digest: v.string(),
            platform: v.optional(v.object({ os: v.string(), architecture: v.string() })),
        }),
    ),
});

const imageManifestSchema = v.object({
    config: v.object({ size: v.number() }),
    layers: v.array(v.object({ size: v.number() })),
});

/** The image an index points at for linux/amd64, or `null` when it has none. */
export function platformDigest(index: v.InferOutput<typeof indexSchema>) {
    // shortcut: assumes amd64 machines, like every machine Clowder provisions today; pass the
    // cluster's platform once arm machines join. Another entry may be an attestation, so none is guessed.
    const entry = index.manifests.find(
        ({ platform }) => platform?.os === "linux" && platform.architecture === "amd64",
    );

    // The registry is untrusted and the digest goes into the next URL.
    return entry && DIGEST.test(entry.digest) ? entry.digest : null;
}

/** A public image's compressed download size in bytes, as its registry reports it. */
export async function registryImageSize(image: string) {
    const reference = parseImageReference(image);

    if (!reference) throw new Error(`${image} is not a valid image reference.`);

    // Docker Hub counts every manifest GET as a pull, so ask its web API instead.
    if (reference.registry === DOCKER_HUB) return dockerHubImageSize(reference);

    const get = manifests(image, reference);
    let manifest = JSON.parse((await get("GET", reference.digest ?? reference.tag)).text);
    const index = v.safeParse(indexSchema, manifest);

    if (index.success) {
        const digest = platformDigest(index.output);

        if (!digest) throw new Error(`${image} has no linux/amd64 image.`);
        manifest = JSON.parse((await get("GET", digest)).text);
    }

    const { config, layers } = v.parse(imageManifestSchema, manifest);

    return layers.reduce((total, layer) => total + layer.size, config.size);
}
