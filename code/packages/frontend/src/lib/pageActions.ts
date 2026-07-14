// The producing PAGE ACTIONS — "Create Transcriptions" / "Create AI descriptions" (page_actions.mdx §2/§5).
// Each resolves its scope (the checked `paths`, else the recursive `root`), calls the enqueue endpoint that
// plans + background-queues the eligible remainder on the server, and toasts the returned count. The
// wording is LOCKED (page_actions.mdx §2): "{N} files will have their Transcriptions created" — where N is
// the eligible remainder (willProcess), never the raw page count — and an honest "nothing to do" when every
// candidate already had the output.
import { toast } from "sonner";
import type { EnqueuePlan } from "@lfb/shared";
import { api } from "../api/client.js";
import { clientLog } from "./clientLog.js";
import { requestStorageSetup } from "./setupWizard.js";
import { withModelReady } from "./transcribe.js";

// The page's set for an action (page_actions.mdx §1.1): a non-empty `paths` = the CHECKED subset; otherwise
// `root` is walked recursively. Callers pass one or the other.
export interface ActionScope {
  root?: string;
  paths?: string[];
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/**
 * Graceful "not yet wired" notice for a page-level domain action whose batch backend endpoint does not
 * exist yet (compress-all, git-ignore-big, publish-ipfs, …). We do NOT fabricate a fake route — we tell
 * the user where the capability lives today, in the app's existing toast.message style
 * (ViewOneDirectoryPage already does this for per-file git-ignore).
 */
export function notWiredToast(what: string, hint?: string): void {
  toast.message(hint ? `${what} — ${hint}` : what);
}

/** "{N} files will have their Transcriptions created" / nothing-to-do (page_actions.mdx §2 — LOCKED). */
function transcribeToast(plan: EnqueuePlan): void {
  if (plan.willProcess === 0) {
    toast.info(`All ${plan.considered} file${plural(plan.considered)} already have transcriptions — nothing to do`);
    return;
  }
  const n = plan.willProcess;
  toast.success(
    n === 1 ? "1 file will have its Transcription created" : `${n} files will have their Transcriptions created`,
  );
}

/** "{N} files will have their AI descriptions created" / nothing-to-do (page_actions.mdx §2 — LOCKED). */
function describeToast(plan: EnqueuePlan): void {
  if (plan.willProcess === 0) {
    toast.info(`All ${plan.considered} file${plural(plan.considered)} already have descriptions — nothing to do`);
    return;
  }
  const n = plan.willProcess;
  toast.success(
    n === 1 ? "1 file will have its AI description created" : `${n} files will have their AI descriptions created`,
  );
}

/** Enqueue transcriptions for the page's scope and toast the eligible count. Returns immediately (the queue
 *  drains in the background; each file surfaces its own `transcribe` dock card). Gated behind the
 *  heavyweight-model provisioning flow (transcribe_engine.mdx §3) — the first bulk run offers the download,
 *  then proceeds (§3.6). */
export async function createTranscriptions(scope: ActionScope): Promise<void> {
  await withModelReady({ label: "transcribe these files", run: () => void doCreateTranscriptions(scope) });
}

async function doCreateTranscriptions(scope: ActionScope): Promise<void> {
  try {
    const plan = await api.transcribeEnqueue(scope);
    // First-time gate (Transcribe.mdx §3.5): the whole scope needs setup — open the wizard, then re-run
    // this exact page action once a Personal storage exists. Nothing was queued.
    if (plan.needsSetup) {
      requestStorageSetup({ mediaPath: plan.setupPath ?? "", actionLabel: "transcribe", retry: () => void createTranscriptions(scope) });
      return;
    }
    transcribeToast(plan);
  } catch (e) {
    clientLog.error("pageActions.createTranscriptions", e);
    toast.error((e as Error).message);
  }
}

/** Enqueue AI descriptions for the page's scope and toast the eligible count. */
export async function createDescriptions(scope: ActionScope): Promise<void> {
  try {
    const plan = await api.describeEnqueue(scope);
    if (plan.needsSetup) {
      requestStorageSetup({
        mediaPath: plan.setupPath ?? "",
        actionLabel: "generate AI descriptions for",
        retry: () => void createDescriptions(scope),
      });
      return;
    }
    describeToast(plan);
  } catch (e) {
    clientLog.error("pageActions.createDescriptions", e);
    toast.error((e as Error).message);
  }
}
