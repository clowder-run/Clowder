import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// biome-ignore lint:@typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;

export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;

// biome-ignore lint:@typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, "children"> : T;

export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

export type RenameTypeToMode<T> = T extends { type: infer M } ? Omit<T, "type"> & { mode: M } : T;

/** Saves `text` as a file named `name` through the browser's download. */
export function downloadText(name: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");

    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}
