// Shared bits for the View-one-file / View-one-directory pages (files.mdx §4, directories.mdx §4):
// the two sticky-flag switches, the "entity is gone" card, and the red "not on this computer yet" card
// that a REMOTE-ONLY file gets instead of it (files.mdx §2.1).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { DownloadCloud } from "lucide-react";
import type { EntityView } from "@lfb/shared";
import { formatBytes } from "@lfb/shared";
import { api } from "@/api/client";
import { copyText } from "@/lib/clipboard";
import { patchEntityBadges } from "@/lib/patchEntityBadges";
import { clientLog } from "../../lib/clientLog.js";

/** The two labeled sticky-flag switches — Never IPFS & Do not compress (menus.mdx §6.6). */
export function FlagSwitches({ view }: { view: EntityView }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (patch: { neverIpfs?: boolean; noCompress?: boolean }) =>
      api.setEntityFlags(view.path, patch),
    onSuccess: (v) => {
      qc.setQueryData(["entity", view.path], v);
      // Patch this entity's badges into the cached File-System listings in place (performance.mdx P-17)
      // instead of invalidating ["fs"] — which would re-walk EVERY open FS column just to flip two flag
      // chips. The mutation already returned the authoritative badges. Mirrors MediaViewer's flags handler.
      patchEntityBadges(qc, v.path, v.badges);
      qc.invalidateQueries({ queryKey: ["repo"] });
    },
    onError: (e: Error) => {
      clientLog.error("FlagSwitches.setEntityFlags", e);
      toast.error(e.message);
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      <Switch
        label="Never IPFS"
        on={view.flags.neverIpfs}
        onToggle={() => m.mutate({ neverIpfs: !view.flags.neverIpfs })}
      />
      <Switch
        label="Do not compress"
        on={view.flags.noCompress}
        onToggle={() => m.mutate({ noCompress: !view.flags.noCompress })}
      />
    </div>
  );
}

function Switch({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="flex items-center gap-2 text-sm text-black/70 select-none">
      <span
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
          on ? "bg-[var(--lfb-primary)]" : "bg-slate-300"
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
            on ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </span>
      {label}
    </button>
  );
}

/**
 * The RED "not on this computer yet" state (files.mdx §2.1, LOCKED — the rule itself is
 * storage_company.mdx §8.5). Shown INSTEAD of {@link EntityHeaderMissing} when the file is absent here
 * *because another of the user's computers has it*, which is a HEALTHY state: red means "available, not
 * here yet", never "lost". Showing the not-found error for it would turn the product's normal
 * second-computer experience into an alarm.
 *
 * Its ONLY action is pull it down — analysis/compression on absent bytes would queue work that cannot run —
 * so this card carries exactly one primary and, beside it, the identity the manifest does know (size, CID,
 * peers). After the pull the next scan makes it an ordinary local file and the page renders normally.
 */
export function EntityRemoteOnly({ view }: { view: EntityView }) {
  const qc = useQueryClient();
  // The peer's nice name, resolved server-side through the travelling device registry; when there is no
  // usable label we say "another of your computers" rather than show an id (devices.mdx §6.9).
  const device = view.addedByDevice ?? "another of your computers";
  const pull = useMutation({
    mutationFn: () => api.pull(view.repo!.repoId, [view.repo!.relPath], { compress: false }),
    onSuccess: () => {
      toast.success("Pulled down");
      // The bytes are here now: this entity re-reads as a normal local file, and the repo's rows/metrics
      // drop it from Pull down.
      qc.invalidateQueries({ queryKey: ["entity", view.path] });
      qc.invalidateQueries({ queryKey: ["repo"] });
    },
    onError: (e: Error) => {
      clientLog.error("EntityRemoteOnly.pull", e);
      toast.error(e.message);
    },
  });
  return (
    <div className="rounded-lg border border-[var(--lfb-bad,#dc2626)] px-4 py-6">
      <h1 className="text-lg font-semibold text-black">{view.name}</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--lfb-bad, #dc2626)" }}>
        On {device} — not on this computer yet.
      </p>
      <p className="mt-1 text-sm text-black/60">
        {view.sizeBytes != null && <>{formatBytes(view.sizeBytes)} · </>}
        This file is safe on your other computer; Large File Bridge can fetch it here over IPFS.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {view.repo && (
          <button
            onClick={() => pull.mutate()}
            disabled={pull.isPending}
            className="flex items-center gap-1.5 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            <DownloadCloud className="h-4 w-4" /> {pull.isPending ? "Pulling…" : "Pull it down"}
          </button>
        )}
        <button
          className="text-[var(--lfb-primary)]"
          onClick={() => { void copyText(view.path, "Path", "EntityRemoteOnly.copyPath"); }}
        >
          Copy path
        </button>
        {view.cid && (
          <button
            className="text-[var(--lfb-primary)]"
            onClick={() => { void copyText(view.cid!, "CID", "EntityRemoteOnly.copyCid"); }}
          >
            Copy CID
          </button>
        )}
        <span className="text-black/50">
          On {view.peers.length} other computer{view.peers.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

/** Card shown when the file/dir is no longer at its path (files.mdx §5, directories.mdx §5). */
export function EntityHeaderMissing({
  view,
  navigate,
}: {
  view: EntityView;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const parent = view.path.replace(/[/\\][^/\\]*$/, "") || view.path;
  const noun = view.kind === "dir" ? "directory" : "file";
  return (
    <div className="rounded-lg border border-[var(--lfb-border)] px-4 py-6">
      <h1 className="text-lg font-semibold text-black">{view.name}</h1>
      <p className="mt-1 text-sm text-black/60">This {noun} is no longer at that path.</p>
      <div className="mt-3 flex gap-3 text-sm">
        <button
          className="text-[var(--lfb-primary)]"
          onClick={() => { void copyText(view.path, "Path", "EntityHeaderMissing.copyPath"); }}
        >
          Copy path
        </button>
        <button className="text-[var(--lfb-primary)]" onClick={() => navigate({ to: "/fs", search: { path: parent } })}>
          Open parent in File System
        </button>
      </div>
    </div>
  );
}
