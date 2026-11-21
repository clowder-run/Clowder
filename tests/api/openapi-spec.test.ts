import { openapiSpec } from "../../packages/api/src/openapi";
import { describe, expect, it } from "vite-plus/test";

describe("OpenAPI spec", () => {
    // The docs render this committed copy. Regenerate it with `pnpm exec vp test run tests/api/openapi-spec.test.ts -u`.
    it("matches the copy the docs render", async () => {
        const spec = await openapiSpec({
            url: "{origin}/rpc/api",
            variables: { origin: { default: "https://clowder.example.com" } },
        });

        await expect(`${JSON.stringify(spec, null, 4)}\n`).toMatchFileSnapshot(
            "../../apps/docs/openapi.json",
        );
    });
});
