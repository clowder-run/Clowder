import { type SerializedPageTree, useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import type { OpenAPIPageProps } from "fumadocs-openapi/ui";
import { OpenAPIPage } from "@/components/api-page";
import { Provider, type ProviderProps } from "@/components/provider";
import { docsOptions, sidebarOptions } from "@/lib/layout.shared";

export interface OpenAPIDocsProps extends ProviderProps {
    tree: SerializedPageTree;
    title: string;
    page: OpenAPIPageProps;
}

/**
 * The React island of generated API reference pages.
 */
export function OpenAPIDocs({ tree, title, page, ...props }: OpenAPIDocsProps) {
    const data = useFumadocsLoader({ tree });

    return (
        <Provider {...props}>
            <DocsLayout {...docsOptions()} sidebar={sidebarOptions} tree={data.tree}>
                <DocsPage full>
                    <DocsTitle>{title}</DocsTitle>
                    <DocsBody>
                        <OpenAPIPage {...page} />
                    </DocsBody>
                </DocsPage>
            </DocsLayout>
        </Provider>
    );
}
