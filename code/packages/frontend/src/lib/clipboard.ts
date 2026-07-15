// The one clipboard write (menus.mdx §3.3). EVERY "Copy path" / "Copy CID" / "Copy Peer ID" surface —
// the entity menu, the row kebabs, the media viewer, the identifier cells — goes through copyText().
//
// Why this exists: the old call sites were all optimistic —
//   navigator.clipboard?.writeText(t).catch(log); toast.success("Path copied");
// which toasts success BEFORE the async write settles, so a rejected write still claims "Path copied"
// and the user pastes nothing. A copy action must report what actually happened.
//
// Rules this util guarantees (menus.mdx §3.3):
//  * It AWAITS the write and toasts the real outcome — success only on a resolved write.
//  * It falls back to the legacy execCommand("copy") path when the async Clipboard API is missing or
//    rejects (insecure context, permissions, an unfocused document), so the copy still lands.
//  * On real failure it toasts an error and logs to the fault trail — never a silent lie.
//  * It NEVER throws: a copy failure must not break the caller's action.
import { toast } from "sonner";
import { clientLog } from "./clientLog.js";

// Legacy fallback: a hidden textarea + execCommand("copy"). Works in insecure contexts and when the
// async Clipboard API rejects. Returns whether the copy actually landed.
function copyViaExecCommand(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Keep it out of view and out of the layout, but still selectable (display:none is NOT selectable).
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Write `text` to the clipboard WITHOUT any toast. Resolves to whether the copy actually landed.
 * Use this when the surface has its own inline feedback (the ✓ check on an identifier cell); use
 * copyText() when the feedback is a toast.
 */
export async function writeClipboard(text: string, context = "clipboard.write"): Promise<boolean> {
  try {
    // Preferred path: the async Clipboard API (secure contexts).
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // Rejected (permissions / insecure context / document not focused) — log it, then try the fallback.
    clientLog.warn(context, e);
  }
  const ok = copyViaExecCommand(text);
  if (!ok) clientLog.warn(context, new Error("clipboard write failed (async API and execCommand both)"));
  return ok;
}

/**
 * Copy `text` to the clipboard and toast the REAL outcome.
 * `label` names the thing being copied ("Path", "CID", "Peer ID") — it becomes "Path copied".
 * Resolves to whether the copy actually landed; callers may ignore the result.
 */
export async function copyText(text: string, label: string, context = "clipboard.copyText"): Promise<boolean> {
  const ok = await writeClipboard(text, context);
  if (ok) toast.success(`${label} copied`);
  else toast.error(`Couldn't copy the ${label.toLowerCase()} to the clipboard`);
  return ok;
}
