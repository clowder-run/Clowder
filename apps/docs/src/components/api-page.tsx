"use client";

import { preload } from "react-dom";
import { createOpenAPIPage } from "fumadocs-openapi/ui";

export const OpenAPIPage = createOpenAPIPage({
    async loadDocument(id) {
        if (import.meta.env.SSR) {
            // The browser starts downloading it with the page.
            preload(`/api/openapi/${id}`, { as: "fetch", crossOrigin: "anonymous" });

            const { openapi } = await import("@/lib/openapi");

            return (await openapi.getSchema(id)).bundled;
        }

        return (await fetch(`/api/openapi/${id}`)).json();
    },
});
