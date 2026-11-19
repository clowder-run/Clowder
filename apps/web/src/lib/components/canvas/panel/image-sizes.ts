import { imageKey } from "@clowder/api/image-reference";
import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { mount, unmount } from "svelte";
import { formatImageSize } from "$lib/format";
import ImageSizeSkeleton from "./image-size-skeleton.svelte";

/** A size in bytes, or `"loading"` while it is being looked up. */
export type ImageSize = number | "loading";

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

// The mounted skeletons, so a widget CodeMirror drops unmounts its own.
const skeletons = new WeakMap<HTMLElement, ReturnType<typeof mount>>();

class SizeWidget extends WidgetType {
    constructor(readonly size: ImageSize) {
        super();
    }

    override eq(other: SizeWidget) {
        return other.size === this.size;
    }

    toDOM() {
        const element = document.createElement("span");
        element.className = "cm-image-size";

        if (this.size === "loading")
            skeletons.set(element, mount(ImageSizeSkeleton, { target: element }));
        else element.textContent = formatImageSize(this.size);

        return element;
    }

    override destroy(element: HTMLElement) {
        const skeleton = skeletons.get(element);

        if (skeleton) void unmount(skeleton);
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

/** Shows each `image:` line's size after it, keyed by `imageKey`. */
export function imageSizes(sizes: Map<string, ImageSize>): Extension {
    return [
        StateField.define({
            create: (state) => sizeDecorations(state, sizes),
            update: (current, transaction) =>
                transaction.docChanged ? sizeDecorations(transaction.state, sizes) : current,
            provide: (field) => EditorView.decorations.from(field),
        }),
        EditorView.theme({
            ".cm-image-size": {
                display: "inline-block",
                marginLeft: "2ch",
                color: "var(--muted-foreground)",
                fontSize: "12px",
            },
        }),
    ];
}
