import type { DocsLayoutProps } from "fumadocs-ui/layouts/docs";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { AccentSwitcher } from "@/components/accent-switcher";
import { ClowderLogo } from "@/components/clowder-logo";
import { GithubRepo } from "@/components/github-repo";
import { appName, gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
    return {
        nav: {
            title: (
                <>
                    <ClowderLogo className="size-6 text-fd-primary" />
                    {appName}
                </>
            ),
        },
        githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    };
}

/** The docs show the repo with its stars and forks instead of a bare GitHub icon. */
export function docsOptions(): BaseLayoutProps {
    return {
        ...baseOptions(),
        githubUrl: undefined,
        links: [
            {
                type: "custom",
                children: <GithubRepo />,
            },
        ],
    };
}

export const sidebarOptions: DocsLayoutProps["sidebar"] = {
    footer: <AccentSwitcher />,
};
