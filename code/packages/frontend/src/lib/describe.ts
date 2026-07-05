// AI-description launcher (ai_description.mdx §2). Mirrors lib/transcribe.ts: wraps api.describeFile in a
// toast.promise so the slow, external vision call shows a spinner then an honest result. Explicit user
// action only — generation uploads the file to the chosen provider.
import { toast } from "sonner";
import type { DescribeResult } from "@lfb/shared";
import { api } from "@/api/client";
import { clientLog } from "./clientLog.js";

/** One-file outcome → a human line (ai_description.mdx §2). */
function msgOne(r: DescribeResult): string {
  switch (r.status) {
    case "described":
      return `AI description generated${r.model ? ` — ${r.model}` : ""}`;
    case "skipped":
      return "Already described";
    case "no_provider":
      return r.reason ?? "No AI provider configured — add an API key";
    case "unsupported":
      return r.reason ?? "Not an image or video";
    default:
      return `Description failed: ${r.reason ?? "error"}`;
  }
}

/** Generate (or regenerate) the AI description for ONE media file. */
export function runDescribeFile(
  path: string,
  name: string,
  opts?: { overwrite?: boolean; provider?: "auto" | "gemini" | "grok" | "openai"; onDone?: () => void },
): void {
  toast.promise(api.describeFile(path, { overwrite: opts?.overwrite, provider: opts?.provider }), {
    loading: `Generating AI description for ${name}…`,
    success: (r) => {
      opts?.onDone?.();
      return msgOne(r);
    },
    error: (e) => {
      clientLog.error("describe.file", e);
      return e instanceof Error ? e.message : "Description failed";
    },
  });
}
