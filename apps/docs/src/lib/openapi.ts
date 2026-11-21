import { createOpenAPI } from "fumadocs-openapi/server";

// openapi.json is generated from the oRPC router by tests/api/openapi-spec.test.ts.
// content/docs/api/meta.json lists its top-level routers as sidebar sections.
export const openapi = createOpenAPI({
    input: { clowder: "./openapi.json" },
    // Each page fetches the spec once from /api/openapi/<id> (api-page.tsx) instead of embedding it.
    includeDocument: false,
});
