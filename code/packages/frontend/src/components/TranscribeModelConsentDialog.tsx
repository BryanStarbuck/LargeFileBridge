// The heavyweight-model consent popup (transcribe_engine.mdx §3.2). Mounted ONCE at the app root; it
// listens on the model-consent bus (lib/transcribe.ts) and opens the FIRST time a user transcribes on an
// Apple-Silicon Mac where the Qwen3-ASR model isn't yet provisioned. It warns how much disk the one-time
// download needs, and offers three choices:
//   • Download & install — provision the higher-quality Qwen3-ASR model (in the background) and proceed now.
//   • Use Whisper now    — skip the download; transcribe with the built-in Whisper (Mac) engine.
//   • Cancel             — back out.
// Either "proceed" choice runs the confirmed action (flow-resume, §3.6). Everything runs on-machine; the
// only networked step is the open-source, content-free weights download the user is approving here.
//
// Matches the app's hand-rolled modal pattern (FirstTimeStorageWizard): a fixed overlay, backdrop-click to
// close, inner stopPropagation.
import { useEffect, useState } from "react";
import { Cpu, Download, Zap, ArrowRight } from "lucide-react";
import { formatBytes } from "@lfb/shared";
import { onModelConsentRequested, type ModelConsentRequest } from "../lib/transcribe.js";

export function TranscribeModelConsentProvider() {
  const [req, setReq] = useState<ModelConsentRequest | null>(null);

  // Subscribe once; the bus keeps a single-slot listener (one provider mounted).
  useEffect(() => onModelConsentRequested((r) => setReq(r)), []);

  if (!req) return null;

  const close = () => setReq(null);
  const enoughDisk = req.freeDiskBytes === 0 || req.freeDiskBytes > req.estimateBytes;

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4" onClick={close}>
      <div
        className="w-[34rem] max-w-full rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-consent-title"
      >
        <div className="flex items-center gap-2 text-[var(--lfb-primary)]">
          <Cpu className="h-5 w-5" />
          <h2 id="model-consent-title" className="text-lg font-semibold text-black/80">
            Set up the high-quality transcription model?
          </h2>
        </div>

        <p className="mt-2 text-sm text-black/70">
          To {req.label}, Large File Bridge can use a powerful local model (<span className="font-medium">Qwen3-ASR</span>) that
          transcribes more accurately. It needs to be <b>downloaded and installed once</b> — after that it runs
          <b> entirely on this computer</b>, and nothing you transcribe ever leaves the machine.
        </p>

        <div className="mt-3 rounded-md border border-[var(--lfb-border)] bg-black/[0.02] px-3 py-2 text-xs text-black/60">
          <div>
            <span className="text-black/40">One-time download</span>{" "}
            <span className="font-medium text-black/75">about {formatBytes(req.estimateBytes)}</span>
            {req.freeDiskBytes > 0 && (
              <>
                {" · "}
                <span className={enoughDisk ? "text-black/55" : "text-red-600"}>{formatBytes(req.freeDiskBytes)} free</span>
              </>
            )}
          </div>
          {!enoughDisk && <div className="mt-1 text-red-600">Not enough free disk for the download — free up space or use Whisper instead.</div>}
          <div className="mt-1 text-black/45">You can change this any time in Settings → Transcription.</div>
        </div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            onClick={close}
            className="rounded-md border border-[var(--lfb-border)] px-4 py-2 text-sm text-black/70 hover:bg-black/5"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              req.onUseFallback();
              close();
            }}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--lfb-border)] px-4 py-2 text-sm text-black/75 hover:bg-black/5"
          >
            <Zap className="h-4 w-4" />
            Use Whisper now
          </button>
          <button
            onClick={() => {
              req.onApproveDownload();
              close();
            }}
            disabled={!enoughDisk}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Download className="h-4 w-4" />
            Download &amp; install
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
