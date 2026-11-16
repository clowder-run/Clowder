import { describe, expect, it } from "vite-plus/test";

import { imageServiceName } from "../../apps/web/src/lib/components/canvas/controls/docker-image";

describe("imageServiceName", () => {
    it("ignores a registry port", () => {
        expect(imageServiceName("localhost:5000/team/app:latest")).toBe("app");
    });
});
