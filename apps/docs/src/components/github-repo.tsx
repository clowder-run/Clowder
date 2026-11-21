import { Component, type ReactNode, Suspense, useSyncExternalStore } from "react";
import { GithubInfo } from "fumadocs-ui/components/github-info";
import { gitConfig } from "@/lib/shared";

// GitHub's API rate limits each visitor, a failed fetch hides the card instead of breaking the island.
class HideOnError extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    render() {
        return this.state.failed ? null : this.props.children;
    }
}

const subscribe = () => () => {};

/** The repo with its stars and forks, fetched in the browser only (false while prerendering and hydrating). */
export function GithubRepo() {
    const isClient = useSyncExternalStore(
        subscribe,
        () => true,
        () => false,
    );

    if (!isClient) return null;

    return (
        <HideOnError>
            <Suspense>
                <GithubInfo owner={gitConfig.user} repo={gitConfig.repo} />
            </Suspense>
        </HideOnError>
    );
}
