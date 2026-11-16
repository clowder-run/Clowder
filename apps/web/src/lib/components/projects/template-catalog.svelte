<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { orpc } from "$lib/api/orpc";
    import Box from "phosphor-svelte/lib/CubeIcon";
    import Search from "phosphor-svelte/lib/MagnifyingGlassIcon";
    import type { AppRouterClient } from "@clowder/api/routers/index";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryStates } from "nuqs-svelte";
    import CatalogTile, {
        tagLabel,
        type CatalogEntry,
    } from "./catalog-tile.svelte";

    type Template = Awaited<
        ReturnType<AppRouterClient["resources"]["listTemplates"]>
    >[number];

    let {
        href,
        onchoose,
    }: {
        /** Where a template tile links. */
        href: (appId: string) => string;
        /** Picks a template in place instead of opening its page. */
        onchoose?: (template: Template) => void;
    } = $props();

    const templatesQuery = createQuery(() =>
        orpc.resources.listTemplates.queryOptions(),
    );

    const filters = useQueryStates(
        {
            q: parseAsString.withDefault(""),
            tag: parseAsString.withDefault("all"),
        },
        { history: "replace", shallow: true, scroll: false },
    );

    const query = $derived(filters.q.current.trim().toLowerCase());

    function matches(entry: CatalogEntry) {
        return (
            !query ||
            [entry.name, entry.description, ...entry.tags].some(
                (text) => text.toLowerCase().includes(query),
            )
        );
    }

    function templateEntry(template: Template): CatalogEntry {
        const latest = template.versions[0];
        const services = latest?.services.length ?? 0;

        return {
            href: href(template.appId),
            name: template.name,
            meta: `${services} ${services === 1 ? "service" : "services"}${latest ? ` · ${latest.version}` : ""}`,
            description: template.description,
            logo: template.logo,
            icon: Box,
            tags: template.tags,
            onclick: onchoose
                ? (event) => {
                      // Modified clicks still open the template's page in a new tab.
                      if (
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey
                      )
                          return;

                      event.preventDefault();
                      onchoose(template);
                  }
                : undefined,
        };
    }

    const databases = $derived(
        (templatesQuery.data ?? []).flatMap((template) =>
            template.type === "database"
                ? [templateEntry(template)]
                : [],
        ),
    );

    const otherTemplates = $derived(
        (templatesQuery.data ?? []).flatMap((template) =>
            template.type === "database"
                ? []
                : [templateEntry(template)],
        ),
    );

    const tags = $derived(
        [
            ...new Set(otherTemplates.flatMap((entry) => entry.tags)),
        ].toSorted(),
    );

    const visibleTemplates = $derived(
        otherTemplates.filter(
            (entry) =>
                (filters.tag.current === "all" ||
                    entry.tags.includes(filters.tag.current)) &&
                matches(entry),
        ),
    );
</script>

{#snippet grid(entries: CatalogEntry[])}
    <ul
        class="-me-px -mb-px grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
    >
        {#each entries as entry (entry.href)}
            <CatalogTile {entry} />
        {/each}
    </ul>
{/snippet}

{#snippet loadingGrid(label: string)}
    <Skeleton loading {label}>
        <ul
            class="-me-px -mb-px grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        >
            {#each { length: 3 }, index (index)}
                <li
                    class="flex flex-col gap-3 border-e border-b border-border p-4"
                >
                    <span class="flex items-center gap-3">
                        <span
                            class="size-10 shrink-0 rounded-full bg-muted"
                        ></span>
                        <span class="min-w-0">
                            <span
                                class="block text-sm font-medium leading-5"
                            >
                                Template name
                            </span>
                            <span
                                class="mt-1 block text-xs leading-5"
                            >
                                1 service · 1.0
                            </span>
                        </span>
                    </span>
                    <span class="text-xs leading-5">
                        A short description of the template that spans
                        two lines.
                    </span>
                </li>
            {/each}
        </ul>
    </Skeleton>
{/snippet}

{#snippet groupHeading(id: string, title: string)}
    <FrameTitle class="text-base">
        <h2 {id}>{title}</h2>
    </FrameTitle>
{/snippet}

{#if templatesQuery.isError}
    <Alert variant="error">
        <AlertDescription>
            Unable to load templates: {templatesQuery.error.message}
        </AlertDescription>
    </Alert>
{:else}
    {#if templatesQuery.isPending || databases.length > 0}
        <Frame role="region" aria-labelledby="group-databases">
            <FrameHeader>
                {@render groupHeading("group-databases", "Databases")}
            </FrameHeader>
            <FramePanel class="overflow-hidden p-0">
                {#if templatesQuery.isPending}
                    {@render loadingGrid("Loading databases")}
                {:else}
                    {@render grid(databases)}
                {/if}
            </FramePanel>
        </Frame>
    {/if}

    {#if templatesQuery.isPending || otherTemplates.length > 0}
        <Frame role="region" aria-labelledby="group-templates">
            <FrameHeader
                class="flex-row flex-wrap items-start justify-between gap-2"
            >
                {@render groupHeading("group-templates", "Templates")}
                <div
                    class="flex w-full flex-wrap items-center gap-2 sm:w-auto"
                >
                    <InputGroup class="w-full sm:w-56">
                        <InputGroupInput
                            type="search"
                            placeholder="Search templates"
                            aria-label="Search templates"
                            bind:value={filters.q.current}
                            disabled={templatesQuery.isPending}
                        />
                        <InputGroupAddon align="inline-start">
                            <Search aria-hidden="true" />
                        </InputGroupAddon>
                    </InputGroup>
                    {#if tags.length > 1}
                        <Select
                            value={filters.tag.current}
                            items={[
                                {
                                    value: "all",
                                    label: "All categories",
                                },
                                ...tags.map((value) => ({
                                    value,
                                    label: tagLabel(value),
                                })),
                            ]}
                            onValueChange={(value) =>
                                (filters.tag.current =
                                    value ?? "all")}
                        >
                            <SelectTrigger
                                size="sm"
                                class="w-auto"
                                aria-label="Filter templates by category"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    value="all"
                                    label="All categories"
                                />
                                {#each tags as value (value)}<SelectItem
                                        {value}
                                        label={tagLabel(value)}
                                    />{/each}
                            </SelectContent>
                        </Select>
                    {/if}
                </div>
            </FrameHeader>
            <FramePanel class="overflow-hidden p-0">
                {#if templatesQuery.isPending}
                    {@render loadingGrid("Loading templates")}
                {:else if visibleTemplates.length === 0}
                    <Empty
                        class="m-3 rounded-xl border border-dashed border-border p-4 md:py-8"
                    >
                        <EmptyHeader>
                            <EmptyDescription>
                                No templates match your filters.
                            </EmptyDescription>
                        </EmptyHeader>
                        <Button
                            variant="outline"
                            size="sm"
                            onclick={() => void filters.set(null)}
                        >
                            Clear filters
                        </Button>
                    </Empty>
                {:else}
                    {@render grid(visibleTemplates)}
                {/if}
            </FramePanel>
        </Frame>
    {/if}
{/if}
