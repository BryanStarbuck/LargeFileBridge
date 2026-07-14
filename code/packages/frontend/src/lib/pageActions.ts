// The producing PAGE ACTIONS — "Create Transcriptions" / "Create AI descriptions" (page_actions.mdx §0.1).
// These NO LONGER enqueue-on-click and toast. Per dialogs.mdx §6.1 they now OPEN THE UNIFIED BATCH-CONFIRM
// POPUP — the SAME "great pop-up" the Transcribable / Describable metric tile opens on the View-one-repo
// page: a candidate list checked by default, uncheck anything, then a solid-blue "Transcribe/Describe N
// files" confirm. The model/provider gate, the background enqueue, and the LOCKED toast all fire on the
// popup's Confirm (in lib/batchPopup.ts). Only WHERE the enqueue happens changed (click → Confirm); Rules
// 1–3 and the first-time-storage gate are unchanged (they run at Apply).
import { toast } from "sonner";
import { openTranscribeBatch, openDescribeBatch, type BatchScope } from "./batchPopup.js";

// The page's set for an action (page_actions.mdx §1.1): a non-empty `paths` = the CHECKED subset; otherwise
// `root` is walked recursively. Callers pass one or the other. (Alias of batchPopup's BatchScope.)
export type ActionScope = BatchScope;

/**
 * Graceful "not yet wired" notice for a page-level domain action whose batch backend endpoint does not
 * exist yet (compress-all, git-ignore-big, publish-ipfs, …). We do NOT fabricate a fake route — we tell
 * the user where the capability lives today, in the app's existing toast.message style.
 */
export function notWiredToast(what: string, hint?: string): void {
  toast.message(hint ? `${what} — ${hint}` : what);
}

/** Open the unified batch-confirm popup for transcriptions over the page's scope (dialogs.mdx §5–§6). */
export async function createTranscriptions(scope: ActionScope): Promise<void> {
  await openTranscribeBatch(scope);
}

/** Open the unified batch-confirm popup for AI descriptions over the page's scope (dialogs.mdx §5–§6). */
export async function createDescriptions(scope: ActionScope): Promise<void> {
  await openDescribeBatch(scope);
}
