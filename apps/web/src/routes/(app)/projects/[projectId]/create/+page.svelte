<script lang="ts">
    import { page } from "$app/state";
    import CatalogTile, {
        type CatalogEntry,
    } from "$lib/components/projects/catalog-tile.svelte";
    import TemplateCatalog from "$lib/components/projects/template-catalog.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { orpc } from "$lib/api/orpc";
    import Container from "phosphor-svelte/lib/ShippingContainerIcon";
    import GitBranch from "phosphor-svelte/lib/GitBranchIcon";
    import HardDrive from "$lib/components/shared/hard-drive-icon.svelte";
    import { createQuery } from "@tanstack/svelte-query";

    const projectId = $derived(page.params.projectId ?? "");

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const project = $derived(projectQuery.data);

    const scratch = $derived<CatalogEntry[]>([
        {
            href: `/projects/${projectId}/create/compose`,
            name: "Compose",
            meta: "Docker Compose",
            description:
                "Start with an empty Docker Compose spec and write it yourself.",
            logo: null,
            icon: Container,
            tags: [],
        },
        {
            href: `/projects/${projectId}/create/git`,
            name: "Compose from Git",
            meta: "Repository",
            description:
                "Deploy a Docker Compose file from a connected Git repository.",
            logo: null,
            icon: GitBranch,
            tags: [],
        },
        {
            href: `/projects/${projectId}/create/bucket`,
            name: "S3 bucket",
            meta: "Storage",
            description:
                "Provision a bucket and its access keys from an S3 connection.",
            logo: null,
            icon: HardDrive,
            tags: [],
        },
    ]);
</script>

<svelte:head>
    <title>
        New resource / {project?.name ?? "Project"} / Clowder
    </title>
</svelte:head>

<div class="flex w-full flex-col gap-6 pt-6">
    <h1 class="sr-only">New resource</h1>
    {#if project?.isInternal}
        <Alert variant="info">
            <AlertDescription>
                Clowder manages this project's internal services. New
                resources can't be added here.
            </AlertDescription>
        </Alert>
    {:else}
        <Frame role="region" aria-labelledby="group-scratch">
            <FrameHeader>
                <FrameTitle class="text-base">
                    <h2 id="group-scratch">Start from scratch</h2>
                </FrameTitle>
            </FrameHeader>
            <FramePanel class="overflow-hidden p-0">
                <ul
                    class="-me-px -mb-px grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
                >
                    {#each scratch as entry (entry.href)}
                        <CatalogTile {entry} />
                    {/each}
                </ul>
            </FramePanel>
        </Frame>

        <TemplateCatalog
            href={(appId) =>
                `/projects/${projectId}/create/${encodeURIComponent(appId)}`}
        />
    {/if}
</div>
