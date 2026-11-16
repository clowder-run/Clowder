<script lang="ts" module>
    import type { Component } from "svelte";

    export type CatalogEntry = {
        href: string;
        name: string;
        meta: string;
        description: string;
        logo: string | null;
        icon: Component;
        tags: string[];
        /** Handles the click in place; the href still opens the full page in a new tab. */
        onclick?: (event: MouseEvent) => void;
    };

    /** "status-page" → "Status page". */
    export function tagLabel(tag: string) {
        const words = tag.replaceAll("-", " ");

        return words[0].toUpperCase() + words.slice(1);
    }
</script>

<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import ChevronRight from "phosphor-svelte/lib/CaretRightIcon";

    let { entry }: { entry: CatalogEntry } = $props();
</script>

<li class="flex min-w-0 border-e border-b border-border">
    <a
        href={entry.href}
        onclick={entry.onclick}
        class="group flex w-full min-w-0 flex-col gap-3 p-4 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
        <span class="flex w-full min-w-0 items-center gap-3">
            {#if entry.logo}
                <img
                    src={entry.logo}
                    alt=""
                    class="size-10 shrink-0 object-contain p-1"
                />
            {:else}
                <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                >
                    <entry.icon class="size-5" aria-hidden="true" />
                </span>
            {/if}
            <span class="min-w-0 flex-1">
                <span
                    class="block truncate text-sm font-medium leading-5"
                >
                    {entry.name}
                </span>
                <span
                    class="mt-1 block truncate text-xs leading-5 tabular-nums text-muted-foreground"
                >
                    {entry.meta}
                </span>
            </span>
            <ChevronRight
                class="size-4 shrink-0 text-muted-foreground opacity-0 transition-[opacity,translate] group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
                aria-hidden="true"
            />
        </span>
        <span
            class="line-clamp-2 flex-1 text-xs leading-5 text-muted-foreground"
        >
            {entry.description}
        </span>
        {#if entry.tags.length > 0}
            <span class="flex flex-wrap gap-1">
                {#each entry.tags as value (value)}<Badge
                        variant="outline"
                    >
                        {tagLabel(value)}
                    </Badge>{/each}
            </span>
        {/if}
    </a>
</li>
