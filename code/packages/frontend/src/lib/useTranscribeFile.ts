// One-file transcription launcher as a HOOK (Transcribe.mdx §2.1 / §5.1). The old fire-and-forget
// runTranscribeFile() gave the button no pending state, so a click looked like nothing happened while
// Whisper ran for minutes. This wraps api.transcribeFile in a react-query mutation so the caller gets:
//   • `isPending` — the button flips to a disabled "Transcribing…" spinner the INSTANT it's clicked, and
//   • a nudge to the progress dock (invalidate ["progress"]) so its live, determinate server card for
//     kind "transcribe" appears within a poll tick, even though the request itself stays open.
// On completion it invalidates the transcript query (so the tab fills in) and toasts the honest outcome.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TranscribeResult } from "@lfb/shared";
import { api } from "@/api/client";
import { clientLog } from "./clientLog.js";
import { transcribeMsgOne } from "./transcribe.js";

export interface UseTranscribeFile {
  /** Kick off transcription (overwrite=true re-transcribes an existing transcript). */
  run: (overwrite?: boolean) => void;
  /** True from click until the run settles — drives the button's disabled/spinner state. */
  isPending: boolean;
}

export function useTranscribeFile(path: string, name: string): UseTranscribeFile {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (overwrite: boolean) => api.transcribeFile(path, overwrite),
    onMutate: () => {
      // Immediate "it started" feedback beyond the button spinner: a live card in the progress dock.
      // The server registers a determinate "transcribe" job; refetching /progress surfaces it fast.
      toast.info(`Transcribing ${name}… this can take a few minutes for a long video.`);
      void qc.invalidateQueries({ queryKey: ["progress"] });
    },
    onSuccess: (r: TranscribeResult) => {
      void qc.invalidateQueries({ queryKey: ["transcript", path] });
      void qc.invalidateQueries({ queryKey: ["progress"] });
      const msg = transcribeMsgOne(r);
      if (r.status === "transcribed") toast.success(msg);
      else if (r.status === "tool_missing" || r.status === "failed") toast.error(msg);
      else toast(msg);
    },
    onError: (e: Error) => {
      clientLog.error("useTranscribeFile", e);
      toast.error(e.message || "Transcription failed");
      void qc.invalidateQueries({ queryKey: ["progress"] });
    },
  });
  return { run: (overwrite = false) => m.mutate(overwrite), isPending: m.isPending };
}
