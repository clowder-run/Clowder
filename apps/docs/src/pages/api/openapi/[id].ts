import type { APIRoute, GetStaticPaths, InferGetStaticPropsType } from "astro";
import { openapi } from "@/lib/openapi";

export const prerender = true;

export const getStaticPaths = (async () => {
    return Object.keys(await openapi.getSchemas()).map((id) => ({ params: { id }, props: { id } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<InferGetStaticPropsType<typeof getStaticPaths>> = async ({ props }) =>
    Response.json((await openapi.getSchema(props.id)).bundled);
