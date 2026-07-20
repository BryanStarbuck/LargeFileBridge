// The hover-info SOURCE store (one_repo.mdx §3.2, non_intrusive_tooltip.mdx §6).
//
// Terse controls — the metric panels (label + number only), the five icon control columns, the Compress
// status icon, the File cell — carry no prose. Their explanation used to appear in a region DOCKED to the
// right of the One-repo metrics strip. It no longer does: that region ate ≥25% of the row and forced the
// metric tiles to wrap onto a second line. The text now goes to the ONE place the app already reserves for
// non-intrusive hover prose — the panel at the bottom of the left bar, above the JFK Social / ACT 3
// Filmmaking links and the account slot (left_bar.mdx §4.1). The metrics strip gets the full page width.
//
// TWO SEPARATE INPUTS, ONE OUTPUT:
//   • `setHoverInfo(text)`  — what is hovered RIGHT NOW; `null` clears it. Called from anywhere, by dozens
//     of cells and icons, on mouseenter/leave. No context needed at the call site.
//   • `setHoverDefault(hint)` — what the panel shows when NOTHING is hovered. A page sets this once (the
//     One-repo page sets it per task tab) and clears it on unmount.
//
// <HoverInfoBridge> is the single component that forwards the store into the app-wide HoverInfoProvider
// the left-bar panel reads. It is mounted ONCE, GLOBALLY, in the app shell — deliberately NOT per page.
// It used to be mounted inside MetricsStrip, which meant only the One-repo page had a consumer: every
// other table that uses the shared icon control columns (IPFS pins, Storage detail, …) published hover
// text into a store nobody was listening to, so hovering those icons explained nothing.
import { useEffect, useState } from "react";
import { useHoverInfoPublisher } from "../../components/hoverinfo/useHoverInfoPublisher.js";

interface HoverState {
  text: string | null;
  defaultHint: string;
}

let current: HoverState = { text: null, defaultHint: "" };
const listeners = new Set<(s: HoverState) => void>();

function emit(next: HoverState): void {
  current = next;
  for (const l of listeners) l(next);
}

/** Publish the hover text (or null to clear back to the page's default hint). Safe to call from anywhere. */
export function setHoverInfo(text: string | null): void {
  if (current.text === text) return;
  emit({ ...current, text });
}

/** Set what the panel shows when nothing is hovered. Pass "" to go back to blank. */
export function setHoverDefault(defaultHint: string): void {
  if (current.defaultHint === defaultHint) return;
  emit({ ...current, defaultHint });
}

function useHoverState(): HoverState {
  const [state, setState] = useState<HoverState>(current);
  useEffect(() => {
    const l = (s: HoverState) => setState(s);
    listeners.add(l);
    // Re-sync on mount: a source may have published between module load and subscribe.
    setState(current);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}

/**
 * Renders nothing. Mounted ONCE in the app shell — it forwards the current hover text (or, at rest, the
 * active page's default hint) into the left-bar hover-info panel.
 */
export function HoverInfoBridge() {
  const { text, defaultHint } = useHoverState();
  const publish = useHoverInfoPublisher();
  const shown = text ?? defaultHint;

  useEffect(() => {
    publish(shown ? { blocks: [{ kind: "text", text: shown }] } : null);
  }, [shown, publish]);

  return null;
}

/**
 * Register a page's at-rest hint for as long as it is mounted (the One-repo page calls this with the
 * active task tab's `defaultHint`). Clears on unmount so the hint never outlives its page.
 */
export function useHoverDefault(hint: string): void {
  useEffect(() => {
    setHoverDefault(hint);
    return () => setHoverDefault("");
  }, [hint]);
}
