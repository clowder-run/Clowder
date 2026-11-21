import type { SVGProps } from "react";

// Same bucket as apps/web/src/lib/components/shared/bucket-icon.svelte, which Phosphor doesn't ship.
export function BucketIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="1em"
            height="1em"
            viewBox="0 0 256 256"
            fill="none"
            stroke="currentColor"
            strokeWidth={24}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...props}
        >
            <ellipse cx="128" cy="60" rx="92" ry="32" />
            <path d="M36 60l20 140c0 17.700 32.200 32 72 32s72-14.300 72-32l20-140" />
        </svg>
    );
}
