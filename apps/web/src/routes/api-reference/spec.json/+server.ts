import { openapiSpec } from "@clowder/api/openapi";
import { json, type RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async ({ url }) =>
    json(await openapiSpec({ url: `${url.origin}/rpc/api` }));
