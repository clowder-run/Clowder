// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import fumadocs from "@fumadocs/astro";

export default defineConfig({
    site: "https://clowder.run",
    integrations: [
        fumadocs({
            components: "./src/components/mdx.tsx",
            includeProcessedMarkdown: true,
            mdastPlugins: (plugins) => [
                ...plugins,
                {
                    // Sätteri drops the code fence meta (`title="..."`) on its way to hast, so pass it as the
                    // `metastring` property, which Fumadocs' rehype-code reads.
                    name: "code-meta",
                    code(node, ctx) {
                        if (!node.meta) return;
                        ctx.setProperty(node, "data", {
                            ...node.data,
                            hProperties: { metastring: node.meta },
                        });
                    },
                },
                {
                    // Astro renders Markdown images outside the React island, where the `img` MDX component
                    // never applies, so turn each into `<ImageZoom>`, which the island renders.
                    name: "image-zoom",
                    image(node, ctx) {
                        ctx.replaceNode(node, {
                            type: "mdxJsxTextElement",
                            name: "ImageZoom",
                            children: [],
                            attributes: [
                                { type: "mdxJsxAttribute", name: "src", value: node.url },
                                { type: "mdxJsxAttribute", name: "alt", value: node.alt ?? "" },
                            ],
                        });
                    },
                },
            ],
        }),
    ],
    vite: {
        plugins: [tailwindcss()],
        // fumadocs-ui (aliased to @fumadocs/base-ui) components import their own CSS, which Node can't load unbundled.
        resolve: { noExternal: ["fumadocs-ui", "@fumadocs/base-ui", "fumadocs-openapi"] },
    },
});
