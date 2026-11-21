import { GitForkIcon, GithubLogoIcon, StarIcon } from "@phosphor-icons/react/ssr";
import { useEffect, useState } from "react";
import { fetchRepoStats, gitConfig, type RepoStats } from "@/lib/shared";

const formatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// One request per page load, shared by every island that renders the card.
let liveStats: Promise<RepoStats | null> | undefined;

/** Starts from the build-time numbers so hydration matches, then swaps in the live ones. */
function useRepoStats(buildStats: RepoStats | null) {
    const [stats, setStats] = useState(buildStats);

    useEffect(() => {
        liveStats ??= fetchRepoStats();
        liveStats.then((live) => live && setStats(live));
    }, []);

    return stats;
}

/** The repo with its stars and forks, matching Fumadocs' GithubInfo. */
export function GithubRepo({ stats: buildStats }: { stats: RepoStats | null }) {
    const stats = useRepoStats(buildStats);

    return (
        <a
            href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
            rel="noreferrer noopener"
            target="_blank"
            className="flex flex-col gap-1.5 rounded-lg p-2 text-sm text-fd-foreground/80 transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
        >
            <p className="flex items-center gap-2 truncate">
                <GithubLogoIcon weight="fill" className="size-3.5" />
                {gitConfig.user}/{gitConfig.repo}
            </p>
            {stats && (
                <div className="flex items-center gap-1 text-xs text-fd-muted-foreground">
                    <StarIcon className="size-3" />
                    <span>{formatter.format(stats.stars)}</span>
                    <GitForkIcon className="ms-2 size-3" />
                    <span>{formatter.format(stats.forks)}</span>
                </div>
            )}
        </a>
    );
}
