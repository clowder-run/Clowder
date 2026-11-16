import YAML from "yaml";

/** The image's last path segment as a Compose service name: `ghcr.io/org/my_app:1` is `my_app`. */
export function imageServiceName(image: string) {
    const repository =
        image
            .split("@")[0]
            ?.replace(/:[^/]*$/u, "")
            .split("/")
            .at(-1) ?? "";

    const name = repository
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, "-")
        .replace(/^[^a-z0-9]+/u, "");

    return name || "app";
}

/** A one-service Compose draft running `image`. */
export function imageCompose(image: string) {
    return YAML.stringify({ services: { [imageServiceName(image)]: { image } } });
}
