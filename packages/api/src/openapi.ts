import { type OpenAPIDocument, OpenAPIGenerator, type OpenAPIV3_1 } from "@orpc/openapi";
import { ValibotToJsonSchemaConverter } from "@orpc/valibot";
import { appRouter } from "./routers/index";

const generator = new OpenAPIGenerator({
    converters: [new ValibotToJsonSchemaConverter()],
});

/** The REST API's OpenAPI document, served at `/api-reference/spec.json` and rendered by the docs. */
export function openapiSpec(server: OpenAPIV3_1.ServerObject): Promise<OpenAPIDocument<"3.1.1">> {
    return generator.generate(appRouter, {
        version: "3.1.1",
        base: {
            info: { title: "Clowder API", version: "1.1.0" },
            servers: [server],
            security: [{ apiKey: [] }],
            components: {
                securitySchemes: {
                    apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
                },
            },
        },
    });
}
