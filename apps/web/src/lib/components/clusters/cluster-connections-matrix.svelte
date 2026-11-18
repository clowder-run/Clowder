<script lang="ts">
    import {
        Frame,
        FrameHeader,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import {
        Table,
        TableBody,
        TableCell,
        TableHead,
        TableHeader,
        TableRow,
    } from "$lib/components/ui/table";

    type Machine = { id: string; name: string };

    type Link = {
        from: string;
        to: string;
        medianMs: number;
        standardDevMs: number;
    };

    let { machines, links }: { machines: Machine[]; links: Link[] } =
        $props();

    // Include endpoints missing from diagnostics so every measured path has a row and column.
    const nodes = $derived.by(() => {
        const unique = new Map(
            machines.map((machine) => [machine.id, machine.name]),
        );

        for (const id of links.flatMap((link) => [
            link.from,
            link.to,
        ])) {
            if (!unique.has(id)) unique.set(id, id);
        }

        return [...unique].map(([id, name]) => ({ id, name }));
    });

    const linksByPath = $derived(
        new Map(
            links.map((link) => [`${link.from} ${link.to}`, link]),
        ),
    );

    // Paths this slow usually cross regions; worth a glance, not an alarm.
    const slowMs = 100;

    function formatMs(value: number) {
        if (!Number.isFinite(value) || value < 0) return "—";

        if (value > 0 && value < 0.1) return "<0.1";

        return value.toFixed(1);
    }
</script>

<Frame class="min-w-0">
    <FrameHeader class="flex-row items-center px-2.5 py-3">
        <FrameTitle>Latency</FrameTitle>
    </FrameHeader>
    <Table variant="card">
        <TableHeader>
            <TableRow>
                <TableHead>
                    <span class="sr-only">
                        From machine, to machine
                    </span>
                    <span aria-hidden="true">From ↓ To →</span>
                </TableHead>
                {#each nodes as node (node.id)}
                    <TableHead class="text-center">
                        {node.name}
                    </TableHead>
                {/each}
            </TableRow>
        </TableHeader>
        <TableBody>
            {#each nodes as from (from.id)}
                <TableRow>
                    <TableCell class="font-medium">
                        {from.name}
                    </TableCell>
                    {#each nodes as to (to.id)}
                        {@const link = linksByPath.get(
                            `${from.id} ${to.id}`,
                        )}
                        <TableCell
                            class="text-center font-mono text-xs tabular-nums"
                        >
                            {#if link}
                                <span
                                    class={link.medianMs >= slowMs
                                        ? "text-warning-foreground"
                                        : "text-foreground"}
                                >
                                    {formatMs(link.medianMs)} ms
                                </span>
                                <span
                                    class="mt-1 block text-[10px] text-muted-foreground"
                                >
                                    ± {formatMs(link.standardDevMs)}
                                </span>
                            {:else}
                                <span
                                    class="text-muted-foreground/50"
                                    aria-label="Not measured"
                                >
                                    —
                                </span>
                            {/if}
                        </TableCell>
                    {/each}
                </TableRow>
            {/each}
        </TableBody>
    </Table>
</Frame>
