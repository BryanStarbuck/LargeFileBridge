// The ONE place a two-pane popup row becomes previewable (warnings.mdx §4.5.2, revision 2026-09-24).
//
// Every host that opens WarningPopup with local-file rows — the one-repo metric tiles on every task tab, the
// transcribe/describe/OCR batch-confirm popup (action links + right-click menus), and the To-Do batch popup —
// builds each row's `preview` with previewForPath() and resolves its bytes with grantPreviewResolver(). Before
// this helper each host hand-rolled both halves, and the batch-confirm popup forgot them entirely: clicking a
// row there left the preview area empty. Remote-only rows (pull-down, deleted here) must NOT call this — they
// have no local bytes and previewing must never fetch.
import { defaultStringifySearch } from "@tanstack/react-router";
import { fileTypeForName, viewerRouteForName } from "@lfb/shared";
import { api } from "../api/client.js";
import { clientLog } from "./clientLog.js";
import type { WarningTarget, WarningTargetPreview } from "../components/ui/warnings/registry.js";

/** The preview for a local file at absolute path `abs`, or undefined for a type the pane can't show. The URL
 *  is left "" — resolved lazily, only for the row the user selects, by grantPreviewResolver(). `openHref` is
 *  the full media viewer for the file (the caption's "Open ↗", opened in a new tab). */
export function previewForPath(abs: string): WarningTargetPreview | undefined {
  const type = fileTypeForName(abs);
  if (type === "other") return undefined;
  return { kind: type, url: "", openHref: `${viewerRouteForName(abs)}${defaultStringifySearch({ path: abs })}` };
}

/** A resolver that mints a short-lived media grant for the selected row. `toAbs` maps a target to its
 *  absolute path (hosts differ in what they put in `id` / `label`). A failed grant logs and returns null so
 *  the pane says "No preview available" instead of spinning. */
export function grantPreviewResolver(
  toAbs: (t: WarningTarget) => string,
  logTag: string,
): (t: WarningTarget) => Promise<string | null> {
  return async (t) => {
    try {
      return (await api.mediaGrant(toAbs(t))).url;
    } catch (e) {
      clientLog.error(logTag, e as Error);
      return null;
    }
  };
}
