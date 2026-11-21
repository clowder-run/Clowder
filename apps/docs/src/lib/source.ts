import { getCollection } from "astro:content";
import * as icons from "@phosphor-icons/react/ssr";
import type { Icon } from "@phosphor-icons/react";
import { llms, loader } from "fumadocs-core/source";
import { toFumadocsSource } from "@fumadocs/astro/source";
import { createElement } from "react";
import { BucketIcon } from "@/components/bucket-icon";
import { openapi } from "./openapi";
import { docsRoute } from "./shared";

type IconName = Extract<keyof typeof icons, `${string}Icon`>;

function kebabCase(text: string) {
    return text.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export const source = loader(
    {
        docs: toFumadocsSource(await getCollection("docs"), await getCollection("meta")),
        // One page per procedure, named after its route: /cluster/addMachine is api/cluster/add-machine.
        openapi: await openapi.staticSource({
            baseDir: "api",
            per: "operation",
            name: (entry) =>
                entry.type === "operation" ? kebabCase(entry.item.path.slice(1)) : entry.item.name,
        }),
    },
    {
        baseUrl: docsRoute,
        plugins: [openapi.loaderPlugin()],
        // `icon` in frontmatter or meta.json is a Phosphor name, e.g. `icon: Rocket`, or `Bucket`.
        icon(name) {
            if (!name) return;

            if (name === "Bucket") return createElement(BucketIcon);

            // SAFETY: a name Phosphor doesn't export reads as undefined and throws below.
            const icon: Icon | undefined = icons[`${name}Icon` as IconName];

            if (!icon) throw new Error(`Unknown Phosphor icon "${name}"`);

            return createElement(icon, { weight: "bold" });
        },
    },
);

export const docsLlms = llms(source, {
    renderPage: async (page) => {
        if (page.type === "docs")
            return `# ${page.data.title} (${page.url})

${await page.data.getText("processed")}`;

        // Operations in the generated spec are self-contained (no $refs), so each page is just its own.
        const { paths } = page.data.getSchema().bundled;

        const operations = page.data
            .getOpenAPIPageProps()
            .operations?.map(({ path, method }) => paths?.[path]?.[method]);

        return `# ${page.data.title} (${page.url})

\`\`\`json
${JSON.stringify(operations, null, 2)}
\`\`\``;
    },
});
