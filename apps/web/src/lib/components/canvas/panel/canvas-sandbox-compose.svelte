<script lang="ts">
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import { createQuery } from "@tanstack/svelte-query";
    import type { EditorView } from "@codemirror/view";
    import type { CanvasResource } from "../graph";
    import EditorImageSizes from "./editor-image-sizes.svelte";

    let {
        resource,
        clusterId,
    }: { resource: CanvasResource; clusterId: string } = $props();

    let view = $state<EditorView>();

    const composeQuery = createQuery(() =>
        orpc.sandboxes.compose.queryOptions({
            input: {
                projectId: resource.projectId,
                resourceId: resource.id,
            },
        }),
    );
</script>

{#if composeQuery.isError}
    <Alert variant="error" class="m-5">
        <AlertDescription>
            {composeQuery.error.message}
        </AlertDescription>
    </Alert>
{:else if !composeQuery.data}
    <Skeleton loading label="Loading Compose" class="h-full">
        <div class="h-full"></div>
    </Skeleton>
{:else}
    <CodeEditor
        value={composeQuery.data.compose ?? ""}
        label="Sandbox Compose"
        fill
        readOnly
        bind:view
    />
    <EditorImageSizes
        {view}
        text={composeQuery.data.compose ?? ""}
        {clusterId}
        projectId={resource.projectId}
    />
{/if}
