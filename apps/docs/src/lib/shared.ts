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

export interface RepoStats {
    stars: number;
    forks: number;
}

/** Null when GitHub refuses, it rate limits each IP to 60 requests an hour. */
export function fetchRepoStats(): Promise<RepoStats | null> {
    return fetch(`https://api.github.com/repos/${gitConfig.user}/${gitConfig.repo}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => data && { stars: data.stargazers_count, forks: data.forks_count })
        .catch(() => null);
}
