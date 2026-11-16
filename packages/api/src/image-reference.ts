// Client-safe: the canvas palette and the server's registry calls both parse references here.

export const DOCKER_HUB = "registry-1.docker.io";

export const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io", DOCKER_HUB]);

const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";

const REFERENCE = new RegExp(
    `^(?<name>(?:(?<host>[a-zA-Z0-9.-]+(?::\\d+)?)/)?(?<path>${COMPONENT}(?:/${COMPONENT})*))` +
        `(?::(?<tag>\\w[\\w.-]{0,127}))?(?:@(?<digest>sha256:[a-f0-9]{64}))?$`,
    "u",
);

export type ImageReference = {
    /** The image as written, without tag or digest. */
    name: string;
    registry: string;
    repository: string;
    tag: string;
    digest: string | null;
};

/** Splits an image reference the way Docker does; `null` when it isn't one. */
export function parseImageReference(image: string): ImageReference | null {
    const groups = REFERENCE.exec(image)?.groups;

    if (!groups?.name || !groups.path) return null;

    // A first segment without a dot or port, other than `localhost`, is a Docker Hub namespace.
    const host = groups.host;
    const isRegistry = host && (host.includes(".") || host.includes(":") || host === "localhost");
    const path = host && !isRegistry ? `${host}/${groups.path}` : groups.path;
    const registry = isRegistry && !DOCKER_HUB_ALIASES.has(host) ? host : DOCKER_HUB;

    if (path !== path.toLowerCase()) return null;

    return {
        name: groups.name,
        registry,
        repository: registry === DOCKER_HUB && !path.includes("/") ? `library/${path}` : path,
        tag: groups.tag ?? "latest",
        digest: groups.digest ?? null,
    };
}
