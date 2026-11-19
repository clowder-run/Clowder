import { describe, expect, it } from "vite-plus/test";
import {
    composeImages,
    lineImage,
} from "../../apps/web/src/lib/components/canvas/panel/image-sizes";
import { formatImageSize } from "../../apps/web/src/lib/format";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("lineImage", () => {
    it.each([
        ["    image: postgres", "registry-1.docker.io/library/postgres:latest"],
        [
            "    image: docker.io/library/postgres:latest",
            "registry-1.docker.io/library/postgres:latest",
        ],
        ['    image: "postgres:18" # pinned later', "registry-1.docker.io/library/postgres:18"],
        ["    image: pkg.bar/sandbox:latest", "pkg.bar/sandbox:latest"],
        [`    image: pkg.bar/sandbox:latest@${DIGEST}`, `pkg.bar/sandbox@${DIGEST}`],
        ["    image: ${IMAGE}", undefined],
        ["    image:", undefined],
        ["    command: postgres", undefined],
    ])("%s", (line, key) => {
        expect(lineImage(line)?.key).toBe(key);
    });
});

describe("composeImages", () => {
    it("lists each image once, as written", () => {
        expect(
            composeImages(
                "services:\n  a:\n    image: postgres\n  b:\n    image: docker.io/postgres:latest\n  c:\n    image: redis:8\n",
            ),
        ).toEqual([
            {
                key: "registry-1.docker.io/library/postgres:latest",
                image: "docker.io/postgres:latest",
            },
            { key: "registry-1.docker.io/library/redis:8", image: "redis:8" },
        ]);
    });
});

describe("formatImageSize", () => {
    it.each([
        [0, "0B"],
        [6_810_000, "6.81MB"],
        [12_500_000, "12.5MB"],
        [356_000_000, "356MB"],
        [999_999, "1MB"],
        [1_170_000_000, "1.17GB"],
    ])("formats %i as %s", (bytes, expected) => {
        expect(formatImageSize(bytes)).toBe(expected);
    });
});
