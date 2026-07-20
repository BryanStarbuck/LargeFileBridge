// Imperative publish access to the app-wide hover-info state (non_intrusive_tooltip.mdx §4).
//
// `useHoverInfoSource()` is the declarative form — it hands back mouse/focus handlers to spread onto an
// element. Some sources aren't a single element (the One-repo page publishes from a module-level store fed
// by dozens of cells and icons), so they need the raw setter instead. Returns a no-op outside a provider,
// so a component using it never crashes in a test/storybook without the shell.
import { useCallback, useContext } from "react";
import { HoverInfoSetterContext, type HoverInfo } from "./HoverInfoContext.js";

export function useHoverInfoPublisher(): (info: HoverInfo | null) => void {
  const setInfo = useContext(HoverInfoSetterContext);
  return useCallback((info: HoverInfo | null) => setInfo?.(info), [setInfo]);
}
