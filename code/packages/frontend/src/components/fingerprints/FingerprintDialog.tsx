// "Calculate perceptual fingerprints" — the web app's power option (perceptual_fingerprint.mdx §FD.6).
//
// Three stages in one darkened-backdrop modal (never window.confirm — dialogs.mdx):
//   1. SETUP   — for a directory: Images / Videos / recursive / recompute; for files: runs at once.
//   2. RUNNING — a live bar fed by long-polling GET /api/fingerprints/jobs/:id (2 s waits, so it updates the
//                moment work lands without hammering the server). Closing the dialog does NOT stop the
//                job — it keeps running and stays visible in the progress dock; Cancel stops it.
//   3. DONE    — counts, failures grouped by reason, Download CSV, and the CSV's path in the state root.
// Results are stored in Postgres by the server, so re-running on an unchanged folder is near-instant.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Fingerprint as FingerprintIcon, Loader2, Download, Copy } from "lucide-react";
import type { FingerprintJobResponse, FingerprintResult } from "@lfb/shared";
import { api } from "@/api/client";
import { clientLog, errMessage } from "../../lib/clientLog.js";
import type { FingerprintRequestUi } from "../../lib/fingerprints.js";

type Stage = "setup" | "running" | "done";

export function FingerprintDialog({ req, onClose }: { req: FingerprintRequestUi; onClose: () => void }) {
  const isDir = "root" in req;
  const [stage, setStage] = useState<Stage>(isDir ? "setup" : "running");
  const [images, setImages] = useState(true);
  const [videos, setVideos] = useState(true);
  const [recursive, setRecursive] = useState(true);
  const [force, setForce] = useState(false);
  const [state, setState] = useState<FingerprintJobResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      alive.current = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const poll = async (first: FingerprintJobResponse) => {
    let cur = first;
    setState(cur);
    while (alive.current && cur.pending) {
      try {
        cur = await api.fingerprintJob(cur.job.id, { waitMs: 2000, limit: 200 });
        if (alive.current) setState(cur);
      } catch (e) {
        clientLog.error("FingerprintDialog.poll", e);
        if (alive.current) setError(errMessage(e));
        return;
      }
    }
    if (alive.current) setStage("done");
  };

  const start = async () => {
    if (started.current) return;
    started.current = true;
    setStage("running");
    setError(null);
    try {
      const first = isDir
        ? await api.fingerprintScan({
            dir: req.root,
            recursive,
            kinds: [images && "image", videos && "video"].filter(Boolean) as Array<"image" | "video">,
            force,
            wait_ms: 1500,
          })
        : await api.fingerprintCompute({ paths: req.paths, force, wait_ms: 15000 });
      await poll(first);
    } catch (e) {
      clientLog.error("FingerprintDialog.start", e);
      setError(errMessage(e));
      setStage("done");
    }
  };

  // Files: no setup step — start as soon as the dialog opens.
  useEffect(() => {
    if (!isDir) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = async () => {
    if (!state) return;
    try {
      await api.fingerprintCancel(state.job.id);
      toast.info("Stopping — files already in progress will finish");
    } catch (e) {
      clientLog.error("FingerprintDialog.cancel", e);
      toast.error(errMessage(e));
    }
  };

  const downloadCsv = async () => {
    if (!state) return;
    try {
      const blob = await api.fingerprintCsvBlob(state.job.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fingerprints_${state.job.id}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      clientLog.error("FingerprintDialog.csv", e);
      toast.error(errMessage(e));
    }
  };

  const job = state?.job;
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const failures = (state?.results ?? []).filter((r) => !r.ok && r.code !== "cancelled");
  const byCode = failures.reduce<Record<string, number>>((m, r) => ((m[r.code ?? "unknown"] = (m[r.code ?? "unknown"] ?? 0) + 1), m), {});
  const single: FingerprintResult | undefined = !isDir && state?.results.length === 1 ? state.results[0] : undefined;
  const title = isDir ? req.root : req.paths.length === 1 ? req.paths[0] : `${req.paths.length} files`;

  return (
    <div className="lfb-scrim fixed inset-0 z-40 grid place-items-center p-4" onClick={onClose}>
      <div
        className="w-[38rem] max-w-full lfb-modal p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fp-title"
      >
        <div className="flex items-center gap-2 text-[var(--lfb-primary)]">
          <FingerprintIcon className="h-5 w-5" />
          <h2 id="fp-title" className="text-lg font-semibold text-black/80">
            Calculate perceptual fingerprints
          </h2>
        </div>
        <div className="mt-1 truncate font-mono text-xs text-black/50" title={title}>
          {title}
        </div>
        <p className="mt-3 text-xs text-black/60">
          A perceptual fingerprint (PDQ) recognizes the same picture or footage after it was resized, recompressed or
          converted. Everything runs on this computer. Results are saved, so files that have not changed are instant
          next time.
        </p>

        {stage === "setup" && (
          <div className="mt-4 space-y-2 text-sm text-black">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} /> Images
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={videos} onChange={(e) => setVideos(e.target.checked)} /> Videos
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} /> Include
              subdirectories
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Recalculate even
              when a saved fingerprint is still valid
            </label>
          </div>
        )}

        {stage !== "setup" && (
          <div className="mt-4 text-sm text-black">
            <div className="h-2 w-full overflow-hidden rounded bg-black/10">
              <div
                className="h-2 bg-[var(--lfb-primary)] transition-all"
                style={{ width: `${job?.discovering ? Math.max(5, pct) : pct}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-black/70">
              <span>
                {job ? `${job.done.toLocaleString()} of ${job.total.toLocaleString()}${job.discovering ? "+ (still finding files)" : ""}` : "Starting…"}
              </span>
              {job && <span>{job.images.toLocaleString()} images · {job.videos.toLocaleString()} videos</span>}
              {job && job.cached > 0 && <span>{job.cached.toLocaleString()} already saved</span>}
              {job && job.failed > 0 && <span className="text-[var(--lfb-bad)]">{job.failed.toLocaleString()} failed</span>}
              {job && stage === "running" && job.eta_ms != null && <span>~{Math.ceil(job.eta_ms / 1000)} s left</span>}
            </div>

            {single?.ok && single.fingerprint && (
              <div className="mt-3 rounded border border-[var(--lfb-border)] p-2 font-mono text-xs break-all">
                {single.fingerprint.value}
                {single.fingerprint.value_alt && (
                  <div className="mt-1 text-black/60" title="The same image with its transparent pixels on black, for copies another tool flattened that way">
                    {single.fingerprint.value_alt} <span className="font-sans">(on black)</span>
                  </div>
                )}
                <div className="mt-1 font-sans text-black/60">
                  {single.fingerprint.kind} · quality {single.fingerprint.quality ?? "—"}
                  {single.fingerprint.frame_count != null && ` · ${single.fingerprint.frame_count} frames`}
                  {single.source !== "computed" && " · from saved"}
                </div>
              </div>
            )}

            {Object.keys(byCode).length > 0 && (
              <div className="mt-3 text-xs text-[var(--lfb-bad)]">
                {Object.entries(byCode).map(([code, n]) => (
                  <div key={code}>
                    {n} × {code.replace(/_/g, " ")}
                    {failures.find((f) => f.code === code)?.error ? ` — e.g. ${failures.find((f) => f.code === code)!.error}` : ""}
                  </div>
                ))}
              </div>
            )}
            {error && <div className="mt-3 text-xs text-[var(--lfb-bad)]">{error}</div>}
            {stage === "done" && job?.csv_path && (
              <div className="mt-3 flex items-center gap-2 text-xs text-black/60">
                <span className="truncate font-mono" title={job.csv_path}>
                  {job.csv_path}
                </span>
                <button
                  className="lfb-btn lfb-btn-secondary"
                  title="Copy the CSV's path"
                  onClick={() => void navigator.clipboard?.writeText(job.csv_path!).then(() => toast.success("Path copied"))}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          {stage === "setup" && (
            <>
              <button onClick={onClose} className="lfb-btn lfb-btn-secondary lfb-btn-lg">
                Cancel
              </button>
              <button onClick={() => void start()} disabled={!images && !videos} className="lfb-btn lfb-btn-primary lfb-btn-lg">
                Calculate
              </button>
            </>
          )}
          {stage === "running" && (
            <>
              <button onClick={() => void cancel()} disabled={!state} className="lfb-btn lfb-btn-secondary lfb-btn-lg">
                Stop
              </button>
              <button onClick={onClose} className="lfb-btn lfb-btn-primary lfb-btn-lg" title="The job keeps running in the background">
                <Loader2 className="h-4 w-4 animate-spin" /> Run in background
              </button>
            </>
          )}
          {stage === "done" && (
            <>
              {state && state.results_total > 0 && (
                <button onClick={() => void downloadCsv()} className="lfb-btn lfb-btn-secondary lfb-btn-lg">
                  <Download className="h-4 w-4" /> Download CSV
                </button>
              )}
              <button onClick={onClose} className="lfb-btn lfb-btn-primary lfb-btn-lg">
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
