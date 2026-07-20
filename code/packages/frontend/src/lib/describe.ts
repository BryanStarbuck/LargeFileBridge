// AI-description launcher (ai_description.mdx §2). Mirrors lib/transcribe.ts: wraps api.describeFile in a
// toast.promise so the slow, external vision call shows a spinner then an honest result. Explicit user
// action only — generation uploads the file to the chosen provider.
import { toast } from "sonner";
import type { DescribeResult } from "@lfb/shared";
import { api } from "@/api/client";
import { clientLog } from "./clientLog.js";
import { requestStorageSetup } from "./setupWizard.js";
import type { WarningKindFilter } from "@/components/ui/warnings/registry";

/**
 * The describe popup's "Filter:" row (ai_description.mdx §12.4.1 / warnings.mdx §4.5.4): AI descriptions
 * cover exactly two media kinds, and a user very often wants only ONE of them (a folder of 1,800 photos and
 * 12 videos gives no way to say "just the videos" short of unchecking 1,800 rows). Both open CHECKED, so
 * the default behavior is unchanged; unchecking a kind hides those rows AND drops them from the batch.
 * The ids MUST match `mediaKindForName()`'s values — that is what tags each target's `kind`.
 */
export const DESCRIBE_KIND_FILTERS: WarningKindFilter[] = [
  { id: "video", label: "Videos" },
  { id: "image", label: "Images" },
];

/** One-file outcome → a human line (ai_description.mdx §2). */
function msgOne(r: DescribeResult): string {
  switch (r.status) {
    case "described":
      return `AI description generated${r.model ? ` — ${r.model}` : ""}`;
    case "rejected": {
      // A refusal is an ANSWER, not a breakdown (ai_description.mdx §2.3) — so it must never read like the
      // `default:` "Description failed" line below. Name the `.ai_description_rejected` just written: the
      // provider's own reason for declining lives in that record, and it is the only thing worth reading next.
      const record = r.descriptionPath?.split("/").pop();
      return `Provider declined to describe this file${r.model ? ` — ${r.model}` : ""}${record ? ` — reason recorded in ${record}` : ""}`;
    }
    case "skipped":
      return "Already described";
    case "no_provider":
      return r.reason ?? "No AI provider configured — add an API key";
    case "unsupported":
      return r.reason ?? "Not an image or video";
    case "needs_setup":
      // First-time gate (Transcribe.mdx §3.5): no Personal storage owns this file yet.
      return "Set up Personal storage first — Settings → Storages";
    default:
      return `Description failed: ${r.reason ?? "error"}`;
  }
}

/** Generate (or regenerate) the AI description for ONE media file.
 *
 *  `onNoProvider` fires when the backend reports `no_provider` (no Gemini/Grok/OpenAI key resolvable on
 *  this machine). The viewer uses it to open the credentials-missing popup (with Close / Instructions)
 *  instead of only flashing a toast — so the user is told exactly how to fix it (ai_credentials.mdx). */
export function runDescribeFile(
  path: string,
  name: string,
  opts?: {
    overwrite?: boolean;
    provider?: "auto" | "gemini" | "grok" | "openai";
    onDone?: () => void;
    onNoProvider?: (reason: string) => void;
    onNeedsSetup?: (reason: string) => void;
    /** Fires on EVERY terminal outcome — success, no_provider, needs_setup, or a thrown error. A caller
     *  driving a busy/spinner state must use this, not `onDone`: a failed run never reaches `onDone` and
     *  would leave the control stuck at "Describing…" forever (the same trap runOcrFile documents). */
    onSettled?: () => void;
  },
): void {
  toast.promise(api.describeFile(path, { overwrite: opts?.overwrite, provider: opts?.provider }), {
    loading: `Generating AI description for ${name}…`,
    success: (r) => {
      if (r.status === "needs_setup") {
        // First-time gate (Transcribe.mdx §3.5): open the wizard; re-run this description once set up.
        requestStorageSetup({
          mediaPath: path,
          actionLabel: "generate an AI description for",
          retry: () => runDescribeFile(path, name, opts),
        });
        opts?.onNeedsSetup?.(r.reason ?? "");
      } else if (r.status === "no_provider") {
        opts?.onNoProvider?.(r.reason ?? "No AI provider configured — add an API key");
      } else {
        opts?.onDone?.();
      }
      opts?.onSettled?.();
      return msgOne(r);
    },
    error: (e) => {
      clientLog.error("describe.file", e);
      opts?.onSettled?.();
      return e instanceof Error ? e.message : "Description failed";
    },
  });
}
