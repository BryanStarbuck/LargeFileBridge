// Class joiner for the shared primitives: clsx for conditionals, tailwind-merge so a caller's
// `className` overrides the component's default instead of losing to CSS source order.
import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
