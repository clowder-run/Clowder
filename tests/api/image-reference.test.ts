import { describe, expect, it } from "vite-plus/test";
import { parseImageReference } from "../../packages/api/src/image-reference";

describe("image references", () => {
    it.each([
        ["ubuntu", "registry-1.docker.io", "library/ubuntu", "latest"],
        ["owner/app:1.2", "registry-1.docker.io", "owner/app", "1.2"],
        ["docker.io/owner/app", "registry-1.docker.io", "owner/app", "latest"],
        ["pkg.bar/sandbox:latest", "pkg.bar", "sandbox", "latest"],
        ["localhost:5000/team/app:v1", "localhost:5000", "team/app", "v1"],
        ["nginx:1.27", "registry-1.docker.io", "library/nginx", "1.27"],
        ["ghcr.io/org/app:1", "ghcr.io", "org/app", "1"],
        [
            "registry.example.com:5000/team/app:latest",
            "registry.example.com:5000",
            "team/app",
            "latest",
        ],
    ])("parses %s", (image, registry, repository, tag) => {
        expect(parseImageReference(image)).toMatchObject({ registry, repository, tag });
    });

    it.each(["", "UPPER/app", "app:", "app@sha256:short", "a b", "a:b:c"])(
        "rejects %j",
        (image) => {
            expect(parseImageReference(image)).toBeNull();
        },
    );
});
