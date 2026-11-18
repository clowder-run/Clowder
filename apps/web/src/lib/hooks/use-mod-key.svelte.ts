import { onMount } from "svelte";

/** The label of the shortcut modifier: ⌘ on Apple devices, Ctrl elsewhere. */
export function useModKey() {
    // Starts as Ctrl so the server render and hydration agree; the browser corrects it on mount.
    let label = $state("Ctrl");

    onMount(() => {
        if (/Mac|iPhone|iPad/u.test(navigator.userAgent)) label = "⌘";
    });

    return {
        get current() {
            return label;
        },
    };
}
