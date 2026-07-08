// The "Compress videos & images inside" pop-over dialog (compress_inside.mdx §1/§3). A darkened-backdrop
// modal (never window.confirm) offering four inputs — Images / Videos checkboxes, an "also recursive"
// checkbox (default ON), and an "Originals" radio group [ Hard delete (DEFAULT) | LargeFileBridge trash
// (recoverable) ] — with a red PNG→JPEG warning shown only while Images is checked. Continue plans +
// background-queues the directory's media and toasts the count (compress_inside.mdx §5/§6); the per-file-
// safe batch drains in the background (surfaced by processing.mdx). Continue is disabled unless at least
// one kind is checked. Matches the app's hand-rolled modal pattern (ConfirmDialog / FirstTimeStorageWizard).
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileArchive, AlertTriangle, Loader2 } from "lucide-react";
import type { DeleteOriginalMode } from "@lfb/shared";
import { api } from "@/api/client";
import { clientLog } from "../../lib/clientLog.js";
import type { CompressInsideRequestUi } from "../../lib/compressInside.js";

export function CompressInsideDialog({
  req,
  onClose,
}: {
  req: CompressInsideRequestUi;
  onClose: () => void;
}) {
  const [images, setImages] = useState(req.images);
  const [videos, setVideos] = useState(req.videos);
  const [recursive, setRecursive] = useState(true); // §3 — default ON
  const [deleteOriginal, setDeleteOriginal] = useState<DeleteOriginalMode>("hard"); // §3 — default Hard delete
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canContinue = images || videos; // §3 — at least one kind

  const start = useMutation({
    mutationFn: () => api.compressInside({ root: req.root, images, videos, recursive, deleteOriginal }),
    onSuccess: (plan) => {
      // §6 — one honest toast, computed from the plan (never a silent start).
      if (plan.queued === 0) {
        const kinds = [images && "images", videos && "videos"].filter(Boolean).join(" / ") || "media";
        toast.info(`Nothing to compress here — no ${kinds} that need it`);
      } else {
        toast.success(
          plan.queued === 1 ? "1 file will be compressed" : `${plan.queued} files will be compressed`,
        );
      }
      onClose();
    },
    onError: (e: Error) => {
      clientLog.error("CompressInsideDialog.start", e);
      toast.error(e.message || "Couldn’t start compression");
    },
  });

  const close = () => {
    if (start.isPending) return; // don't dismiss mid-request
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={close}>
      <div
        className="w-[34rem] max-w-full rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="compress-inside-title"
      >
        <div className="flex items-center gap-2 text-[var(--lfb-primary)]">
          <FileArchive className="h-5 w-5" />
          <h2 id="compress-inside-title" className="text-lg font-semibold text-black/80">
            Compress videos &amp; images inside
          </h2>
        </div>
        <div className="mt-1 truncate font-mono text-xs text-black/50" title={req.root}>
          {req.root}
        </div>

        <div className="mt-5 space-y-3 text-sm text-black">
          {/* Images + its conditional red PNG warning */}
          <div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} />
              <span>Images</span>
            </label>
            {images && (
              <div className="mt-1 flex items-center gap-1.5 pl-6 text-xs text-[var(--lfb-bad)]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Warning: PNG files will be turned into JPEG files.
              </div>
            )}
          </div>

          {/* Videos */}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={videos} onChange={(e) => setVideos(e.target.checked)} />
            <span>Videos</span>
          </label>

          {/* Recursive (default ON) */}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
            <span>Also compress recursively in subdirectories</span>
          </label>

          {/* Originals radio group */}
          <fieldset className="mt-1 rounded-lg border border-[var(--lfb-border)] p-3">
            <legend className="px-1 text-xs font-medium text-black/60">Originals</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="delete-original"
                checked={deleteOriginal === "hard"}
                onChange={() => setDeleteOriginal("hard")}
              />
              <span>Hard delete</span>
            </label>
            <label className="mt-1.5 flex items-center gap-2">
              <input
                type="radio"
                name="delete-original"
                checked={deleteOriginal === "trash"}
                onChange={() => setDeleteOriginal("trash")}
              />
              <span>LargeFileBridge trash (recoverable)</span>
            </label>
          </fieldset>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={close}
            disabled={start.isPending}
            className="rounded-md border border-[var(--lfb-border)] px-4 py-2 text-sm text-black/70 hover:bg-black/5 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={() => start.mutate()}
            disabled={!canContinue || start.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {start.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
