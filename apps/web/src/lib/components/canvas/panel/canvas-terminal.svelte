<script lang="ts">
    import { client } from "$lib/api/orpc";
    import {
        Xterm,
        XtermAddon,
        type Terminal,
    } from "@battlefieldduck/xterm-svelte";
    import { onDestroy } from "svelte";

    let {
        projectId,
        resourceId,
        service,
    }: {
        projectId: string;
        resourceId: string;
        /** The compose service selected on the canvas; the first one when absent. */
        service: string | undefined;
    } = $props();

    const options = {
        fontFamily: "Maple Mono, ui-monospace, monospace",
        fontSize: 13,
        cursorBlink: true,
    };

    let container = $state<HTMLDivElement>();

    let session: string | undefined;

    // Unmounting the tab ends the shell.
    const controller = new AbortController();

    let resizes: ResizeObserver | undefined;

    onDestroy(() => {
        controller.abort();
        resizes?.disconnect();
    });

    function send(input: { data?: string; size?: [number, number] }) {
        if (session)
            void client.terminal
                .send({ id: session, ...input })
                .catch(() => {});
    }

    async function onLoad(terminal: Terminal) {
        if (container) {
            const style = getComputedStyle(container);

            terminal.options.theme = {
                background: style.backgroundColor,
                foreground: style.color,
                cursor: style.color,
            };
        }

        const addon = new (await XtermAddon.FitAddon()).FitAddon();

        terminal.loadAddon(addon);
        addon.fit();
        resizes = new ResizeObserver(() => addon.fit());

        if (container) resizes.observe(container);
        terminal.focus();

        try {
            const events = await client.terminal.open(
                {
                    projectId,
                    resourceId,
                    service,
                    cols: terminal.cols,
                    rows: terminal.rows,
                },
                { signal: controller.signal },
            );

            for await (const event of events) {
                if (event.type === "output")
                    terminal.write(event.data);
                else {
                    session = event.id;
                    // The panel may have resized while the shell was starting.
                    send({ size: [terminal.cols, terminal.rows] });
                }
            }

            terminal.write("\r\n\x1b[2mSession ended.\x1b[0m\r\n");
        } catch (error) {
            if (!controller.signal.aborted)
                terminal.write(
                    `\x1b[31m${error instanceof Error ? error.message : "The terminal disconnected."}\x1b[0m\r\n`,
                );
        } finally {
            session = undefined;
        }
    }
</script>

<div bind:this={container} class="h-full bg-card p-4 text-foreground">
    <Xterm
        class="h-full"
        {options}
        {onLoad}
        onData={(data) => send({ data })}
        onResize={({ cols, rows }) => send({ size: [cols, rows] })}
    />
</div>
