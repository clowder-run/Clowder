import { useEffect, useState } from "react";

// Same accents and swatches as apps/web/src/lib/theme.svelte.ts; the CSS lives in global.css.
const accents = [
    { value: "lime", label: "Lime", color: "oklch(0.86 0.2 128)" },
    { value: "teal", label: "Teal", color: "oklch(0.7 0.12 180)" },
    { value: "sky", label: "Sky", color: "oklch(0.68 0.14 240)" },
    { value: "violet", label: "Violet", color: "oklch(0.52 0.19 305)" },
    { value: "pink", label: "Pink", color: "oklch(0.7 0.18 350)" },
    { value: "orange", label: "Orange", color: "oklch(0.68 0.19 45)" },
    { value: "mono", label: "Monochrome", color: "oklch(0.97 0 0)" },
];

export function AccentSwitcher() {
    const [current, setCurrent] = useState("lime");

    // The head script in Layout.astro already applied the saved accent before first paint.
    useEffect(() => {
        setCurrent(document.documentElement.dataset.accent ?? "lime");
    }, []);

    function select(value: string) {
        setCurrent(value);
        document.documentElement.dataset.accent = value;
        document.cookie = `accent=${value}; path=/; max-age=31536000; samesite=lax`;
    }

    return (
        <div
            role="radiogroup"
            aria-label="Accent color"
            className="flex justify-between rounded-lg border bg-fd-secondary/50 p-0.5 mt-2"
        >
            {accents.map((accent) => (
                <button
                    key={accent.value}
                    type="button"
                    role="radio"
                    aria-checked={current === accent.value}
                    aria-label={accent.label}
                    title={accent.label}
                    onClick={() => select(accent.value)}
                    className="grid size-7 place-items-center rounded-md hover:bg-fd-accent aria-checked:bg-fd-accent"
                >
                    <span
                        className="size-3.5 rounded-full border border-fd-foreground/16"
                        style={{ background: accent.color }}
                    />
                </button>
            ))}
        </div>
    );
}
