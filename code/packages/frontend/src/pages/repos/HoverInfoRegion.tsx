// The hover-info region (task_tabs.mdx §3, non_intrusive_tooltip.mdx §6). The metric panels are terse
// (label + number only); their explanation — and a one-line summary of whatever row / tooltip target /
// action link the user is hovering — appears HERE, in one persistent region to the right of the metrics
// strip. It is the non-intrusive-tooltip content model, docked instead of floated, so the panels stay
// clean and nothing covers the row being read.
//
// Fed by a tiny module-level store (no context wrapping needed): any panel / row cell / status icon calls
// `setHoverInfo(text)` on mouseenter and `setHoverInfo(null)` on leave; the region shows the current text
// or, when nothing is hovered, the active tab's default hint.
import { useEffect, useState } from "react";

let current: string | null = null;
const listeners = new Set<(t: string | null) => void>();

/** Publish the hover text (or null to clear back to the tab's default hint). Safe to call from anywhere. */
export function setHoverInfo(text: string | null): void {
  current = text;
  for (const l of listeners) l(text);
}

function useHoverInfo(): string | null {
  const [text, setText] = useState<string | null>(current);
  useEffect(() => {
    const l = (t: string | null) => setText(t);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return text;
}

export function HoverInfoRegion({ defaultHint }: { defaultHint: string }) {
  const text = useHoverInfo();
  // Reset to the default hint whenever the region unmounts (repo change) so stale text never lingers.
  useEffect(() => () => setHoverInfo(null), []);
  // HEIGHT ISOLATION (fixes the hover-jitter loop). The metrics panels — the sibling in this
  // `items-stretch` row — are the ONLY thing allowed to set the row's height. If this region's text
  // could grow the row, a tall tooltip would push the page down, move the hovered icon out from under
  // the cursor, clear the text, shrink the row, snap back up, re-hover… forever. So the text lives in an
  // absolutely-positioned layer that contributes ZERO height: the outer wrapper stretches to the panels'
  // height, and the inner `absolute inset-0` layer fills exactly that height and clips anything past it.
  //
  // VERTICAL BEHAVIOUR. `flex flex-col` + `overflow-hidden` + a child with `my-auto`: when the text fits
  // it is centered top-to-bottom (the look we want); when it overflows, the auto margins collapse to 0 so
  // the child pins to the TOP and the surplus is clipped off the BOTTOM — the top is never cut off.
  return (
    <div className="relative min-w-0 flex-1 self-stretch">
      <div className="absolute inset-0 flex flex-col overflow-hidden px-3">
        <div className="my-auto text-sm leading-snug text-black/60" aria-live="polite">
          {text ?? defaultHint}
        </div>
      </div>
    </div>
  );
}
