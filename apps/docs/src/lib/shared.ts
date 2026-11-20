import { createGetUrl } from "fumadocs-core/source";

export const appName = "Clowder";

export const docsRoute = "/docs";

export const docsImageRoute = "/og/docs";

export const gitConfig = {
    user: "clowder-run",
    repo: "clowder",
    branch: "master",
};

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
    const segments = [...page.slugs, "image.webp"];

    return { segments, url: getImageUrl(segments, page.locale) };
}
