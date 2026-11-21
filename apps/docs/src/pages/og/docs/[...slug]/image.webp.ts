import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { APIRoute, GetStaticPaths, InferGetStaticPropsType } from "astro";
import { generateOGImage } from "fumadocs-ui/og/takumi";
import { ClowderLogo } from "@/components/clowder-logo";
import { source } from "@/lib/source";
import { appName } from "@/lib/shared";

export const prerender = true;

// The same Allo cut the docs use (allo-font/friendly).
const allo = readFile(
    fileURLToPath(import.meta.resolve("allo-font/fonts/webfonts/AlloVariableFriendly.woff2")),
);

export const getStaticPaths = (() => {
    return source.getPages().map((page) => ({
        params: { slug: decodeURI(page.slugs.join("/")) || undefined },
        props: { page },
    }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<InferGetStaticPropsType<typeof getStaticPaths>> = async ({
    props: { page },
}) => {
    return generateOGImage({
        title: page.data.title,
        description: page.data.description,
        site: appName,
        // The docs' default lime accent (global.css).
        icon: ClowderLogo({ width: 56, height: 56, fill: "oklch(0.86 0.2 128)" }),
        primaryColor: "oklch(0.86 0.2 128 / 0.3)",
        primaryTextColor: "oklch(0.86 0.2 128)",
        fonts: [{ name: "Allo", data: await allo }],
        format: "webp",
    });
};
