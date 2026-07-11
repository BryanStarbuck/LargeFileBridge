// The app-level hover-info state (non_intrusive_tooltip.mdx §4). A single context holds the ONE
// currently-hovered payload (or none); sources set it on enter/focus and clear it on leave/blur (with a
// ~120ms clear debounce so the panel doesn't flicker blank while the pointer crosses the 1px gap between
// two adjacent chips). The panel at the bottom of the left bar reads it. Most-recent hover wins, so moving
// from a chip to a row cleanly swaps the content.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// One block shown in the panel. A "code" block is a badge/color key (the exact rounded-rect chip + name +
// optional one-line meaning); a "detail" block is up-to-three lines about a hovered file/directory.
export type HoverInfoBlock =
  | {
      kind: "code";
      chip: { letter: string; bg: string; ink: string; border?: string };
      name: string;
      line?: string;
    }
  | { kind: "detail"; title: string; lines: string[] };

export interface HoverInfo {
  blocks: HoverInfoBlock[];
}

interface HoverInfoCtx {
  info: HoverInfo | null;
  setInfo: (info: HoverInfo | null) => void;
}

const Ctx = createContext<HoverInfoCtx | null>(null);

const CLEAR_DEBOUNCE_MS = 120;

export function HoverInfoProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<HoverInfo | null>(null);
  const value = useMemo<HoverInfoCtx>(() => ({ info, setInfo }), [info]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read the single active hover payload (the panel uses this). Returns null when nothing is hovered. */
export function useHoverInfo(): HoverInfo | null {
  return useContext(Ctx)?.info ?? null;
}

/**
 * Register an element as a hover source (non_intrusive_tooltip.mdx §2). Returns the mouse/focus handlers to
 * spread onto the element: enter/focus publishes `payload` into the panel; leave/blur clears it after a
 * short debounce. Pass a STABLE payload to avoid needless work — the handlers always read the latest value.
 */
export function useHoverInfoSource(payload: HoverInfo) {
  const ctx = useContext(Ctx);
  // Keep the latest payload in a ref so the stable handlers publish current data without re-subscribing.
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClear = useCallback(() => {
    if (clearTimer.current) {
      clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
  }, []);

  const set = useCallback(() => {
    cancelClear();
    ctx?.setInfo(payloadRef.current);
  }, [ctx, cancelClear]);

  const clear = useCallback(() => {
    cancelClear();
    clearTimer.current = setTimeout(() => {
      ctx?.setInfo(null);
      clearTimer.current = null;
    }, CLEAR_DEBOUNCE_MS);
  }, [ctx, cancelClear]);

  return useMemo(
    () => ({ onMouseEnter: set, onMouseLeave: clear, onFocus: set, onBlur: clear }),
    [set, clear],
  );
}
