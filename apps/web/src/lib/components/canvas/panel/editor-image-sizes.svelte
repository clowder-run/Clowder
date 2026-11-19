<script lang="ts" module>
    import { orpc } from "$lib/api/orpc";

    /** The cluster's image list: shared, so the panel can start it before Compose opens. */
    export function clusterImageSizes(
        clusterId: string,
        projectId: string,
    ) {
        return orpc.resources.getImageSizes.queryOptions({
            input: { clusterId, projectId },
            enabled: clusterId.length > 0,
            retry: false,
            // Listing every machine's images takes seconds, like `uc images`.
            staleTime: 5 * 60_000,
        });
    }
</script>

<script lang="ts">
    import { Compartment, StateEffect } from "@codemirror/state";
    import type { EditorView } from "@codemirror/view";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        composeImages,
        imageSizes,
        type ImageSize,
    } from "./image-sizes";

    let {
        view,
        text,
        clusterId,
        projectId,
    }: {
        view: EditorView | undefined;
        // The saved Compose, so typing an image doesn't look up every prefix of it.
        text: string;
        clusterId: string;
        projectId: string;
    } = $props();

    const clusterQuery = createQuery(() =>
        clusterImageSizes(clusterId, projectId),
    );

    const images = $derived(composeImages(text));

    // Not pulled on the cluster yet, so its registry is asked instead.
    const missing = $derived(
        clusterQuery.isLoading
            ? []
            : images.filter(
                  ({ key }) => clusterQuery.data?.[key] === undefined,
              ),
    );

    const registryQueries = createQueries(() => ({
        queries: missing.map(({ image }) =>
            orpc.resources.getRegistryImageSize.queryOptions({
                input: { image },
                retry: false,
                staleTime: 60 * 60_000,
            }),
        ),
    }));

    // A size that can't be found is left out rather than shown as an error.
    const sizes = $derived.by(() => {
        const sizes = new Map<string, ImageSize>();

        for (const { key } of images) {
            const size = clusterQuery.data?.[key];

            if (size !== undefined) sizes.set(key, size);
            else if (clusterQuery.isLoading)
                sizes.set(key, "loading");
        }

        missing.forEach(({ key }, index) => {
            const query = registryQueries[index];

            if (query?.isLoading) sizes.set(key, "loading");
            else if (query?.data != null) sizes.set(key, query.data);
        });

        return sizes;
    });

    const extension = new Compartment();

    let attached: EditorView | undefined;

    // Sizes arrive after the editor mounts, so they live in a compartment.
    $effect(() => {
        if (!view) return;
        const content = imageSizes(sizes);

        if (attached === view)
            view.dispatch({
                effects: extension.reconfigure(content),
            });
        else {
            attached = view;
            view.dispatch({
                effects: StateEffect.appendConfig.of(
                    extension.of(content),
                ),
            });
        }
    });
</script>
