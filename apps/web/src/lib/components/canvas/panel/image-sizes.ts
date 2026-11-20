import { imageKey } from "@clowder/api/image-reference";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { formatImageSize } from "$lib/format";
import { createSkeletonBox } from "skullet";

/**
 * A size in bytes, or `"loading"` while it is being looked up. `download` marks a registry's
 * compressed size, which is smaller than the unpacked size the cluster reports.
 */
export type ImageSize = { bytes: number; download: boolean } | "loading";

// A regex instead of the YAML tree, so sizes stay while the file is half typed.
const IMAGE_LINE = /^\s*image:\s*(["']?)([^\s"'#]+)\1\s*(?:#.*)?$/u;

/** The image an `image:` line names and its `imageKey`, or `undefined` for any other line. */
export function lineImage(line: string) {
    const image = IMAGE_LINE.exec(line)?.[2];
    const key = image && imageKey(image);

    return key ? { image, key } : undefined;
}

/** Every image a Compose file names, once each. */
export function composeImages(text: string) {
    const images = new Map<string, string>();

    for (const line of text.split("\n")) {
        const found = lineImage(line);

        if (found) images.set(found.key, found.image);
    }

    return Array.from(images, ([key, image]) => ({ key, image }));
}

class SizeWidget extends WidgetType {
    constructor(readonly size: ImageSize) {
        super();
    }

    override eq(other: SizeWidget) {
        return this.size === "loading" || other.size === "loading"
            ? this.size === other.size
            : this.size.bytes === other.size.bytes && this.size.download === other.size.download;
    }

    toDOM() {
        const element = document.createElement("span");
        element.className = "cm-image-size";

        // The shared <Skeleton> wraps blocks it measures, which breaks a code line; skullet's own
        // bar is the inline form of it.
        if (this.size === "loading")
            element.append(createSkeletonBox({ width: "5ch", height: "0.9em", radius: "4px" }));
        else {
            element.textContent = formatImageSize(this.size.bytes);
            element.title = this.size.download
                ? "Download size from the registry; not pulled on this cluster yet"
                : "Size on the cluster";
        }

        return element;
    }
}

function sizeDecorations(state: EditorState, sizes: Map<string, ImageSize>) {
    const ranges = new RangeSetBuilder<Decoration>();

    for (let n = 1; n <= state.doc.lines; n++) {
        const line = state.doc.line(n);
        const found = lineImage(line.text);
        const size = found && sizes.get(found.key);

        if (size !== undefined)
            ranges.add(
                line.to,
                line.to,
                Decoration.widget({ widget: new SizeWidget(size), side: 1 }),
            );
    }

    return ranges.finish();
}

// Built once: every `EditorView.theme` call mounts a new style rule, and sizes reconfigure often.
const sizeTheme = EditorView.theme({
    ".cm-image-size": {
        display: "inline-block",
        verticalAlign: "middle",
        marginLeft: "2ch",
        color: "var(--muted-foreground)",
        fontSize: "12px",
    },
});

/** Shows each `image:` line's size after it, keyed by `imageKey`. */
export function imageSizes(sizes: Map<string, ImageSize>): Extension {
    return [
        StateField.define({
            create: (state) => sizeDecorations(state, sizes),
            update: (current, transaction) =>
                transaction.docChanged ? sizeDecorations(transaction.state, sizes) : current,
            provide: (field) => EditorView.decorations.from(field),
        }),
        sizeTheme,
    ];
}
