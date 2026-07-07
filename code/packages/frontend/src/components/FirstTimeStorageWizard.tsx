// The first-time storage-setup wizard (Transcribe.mdx §3.5, storage_personal.mdx §3b). Mounted ONCE at the
// app root; it listens on the setupWizard bus and opens when a derived-artifact action (Transcribe / Get
// AI details) hits `needs_setup` — the user has no Personal storage yet and nothing owns the file.
//
// It creates the ONE Personal storage at its canonical root (~/BGit/Bryan_git/personal_large_files_bridge/)
// and lets the user pick HOW it is kept:
//   • Dedicated Git repo (recommended) — versioned + synced; transcripts/descriptions are tracked in the
//     repo (placement rule B, NOT git-ignored).
//   • Plain folder — the same folder, not a git repo; results kept locally and synced over IPFS.
// On success it re-runs the original action (`retry`) so the user lands back where they clicked — no reload.
//
// Matches the app's hand-rolled modal pattern (CredentialsMissingDialog / ReposPage AddRepoDialog): a fixed
// overlay, backdrop-click to close, inner stopPropagation.
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderCog, FolderGit2, Folder, Loader2, ArrowRight } from "lucide-react";
import { api } from "@/api/client";
import { clientLog } from "../lib/clientLog.js";
import { onStorageSetupRequested, type StorageSetupRequest } from "../lib/setupWizard.js";

// The canonical Personal storage root — must match the backend (storage.service.createPersonalStorage /
// storage_personal.mdx §1). Shown to the user and used to preview where results will land.
const PERSONAL_ROOT = "~/BGit/Bryan_git/personal_large_files_bridge";

export function FirstTimeStorageWizardProvider() {
  const [req, setReq] = useState<StorageSetupRequest | null>(null);
  const [dedicatedRepo, setDedicatedRepo] = useState(true); // default to the recommended git-repo option
  const qc = useQueryClient();

  // Subscribe once; the bus keeps a single-slot listener (one provider mounted).
  useEffect(() => onStorageSetupRequested((r) => { setReq(r); setDedicatedRepo(true); }), []);

  const create = useMutation({
    mutationFn: () => api.createPersonalStorage(dedicatedRepo),
    onSuccess: () => {
      // A storage now exists — refresh anything that keyed off "no storage", then re-run the action.
      void qc.invalidateQueries({ queryKey: ["storages"] });
      void qc.invalidateQueries({ queryKey: ["storageSettings"] });
      toast.success(dedicatedRepo ? "Personal storage created (dedicated Git repo)" : "Personal storage created");
      const retry = req?.retry;
      setReq(null);
      retry?.();
    },
    onError: (e: Error) => {
      clientLog.error("FirstTimeStorageWizard.create", e);
      toast.error(e.message || "Couldn’t create Personal storage");
    },
  });

  if (!req) return null;

  const close = () => {
    if (create.isPending) return; // don't dismiss mid-create
    setReq(null);
  };

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4" onClick={close}>
      <div
        className="w-[34rem] max-w-full rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-wizard-title"
      >
        <div className="flex items-center gap-2 text-[var(--lfb-primary)]">
          <FolderCog className="h-5 w-5" />
          <h2 id="setup-wizard-title" className="text-lg font-semibold text-black/80">
            Set up Personal storage
          </h2>
        </div>

        <p className="mt-2 text-sm text-black/70">
          Before Large File Bridge can {req.actionLabel} this file, it needs a place to keep the results and
          sync them across your computers. This happens once.
        </p>
        <p className="mt-2 truncate rounded-md bg-black/5 px-3 py-2 font-mono text-xs text-black/60" title={req.mediaPath}>
          {req.mediaPath}
        </p>

        {/* The two ways to keep Personal storage. */}
        <div className="mt-4 space-y-2">
          <OptionRow
            selected={dedicatedRepo}
            onSelect={() => setDedicatedRepo(true)}
            icon={<FolderGit2 className="h-5 w-5" />}
            title="Dedicated Git repo"
            recommended
            body="Versioned and synced to your other computers. Your transcripts & AI descriptions are tracked in the repo."
          />
          <OptionRow
            selected={!dedicatedRepo}
            onSelect={() => setDedicatedRepo(false)}
            icon={<Folder className="h-5 w-5" />}
            title="Plain folder"
            body="The same folder, not a Git repo. Results are kept locally and synced over IPFS."
          />
        </div>

        <div className="mt-4 rounded-md border border-[var(--lfb-border)] bg-black/[0.02] px-3 py-2 text-xs text-black/55">
          <span className="text-black/40">Created at</span>{" "}
          <span className="font-mono text-black/70">{PERSONAL_ROOT}/</span>
          <div className="mt-1">
            <span className="text-black/40">Results saved under</span>{" "}
            <span className="font-mono text-black/70">{PERSONAL_ROOT}/.transcribe/…</span>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={close}
            disabled={create.isPending}
            className="rounded-md border border-[var(--lfb-border)] px-4 py-2 text-sm text-black/70 hover:bg-black/5 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            {create.isPending ? "Setting up…" : "Set up & continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OptionRow({
  selected,
  onSelect,
  icon,
  title,
  body,
  recommended = false,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  body: string;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
        selected ? "border-[var(--lfb-primary)] bg-[var(--lfb-primary)]/5" : "border-[var(--lfb-border)] hover:bg-black/[0.03]"
      }`}
    >
      <span className={`mt-0.5 ${selected ? "text-[var(--lfb-primary)]" : "text-black/40"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="font-medium text-black/80">{title}</span>
          {recommended && (
            <span className="rounded-full bg-[var(--lfb-primary)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--lfb-primary)]">
              Recommended
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-black/55">{body}</span>
      </span>
      <span
        className={`mt-1 h-4 w-4 shrink-0 rounded-full border-2 ${
          selected ? "border-[var(--lfb-primary)] bg-[var(--lfb-primary)]" : "border-black/25"
        }`}
      />
    </button>
  );
}
