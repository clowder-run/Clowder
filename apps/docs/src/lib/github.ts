import { fetchRepoStats } from "./shared";

/** Fetched once per build (or dev server start) so the prerendered card already has numbers. */
export const repoStats = await fetchRepoStats();
