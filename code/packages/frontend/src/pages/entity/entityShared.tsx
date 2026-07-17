// Shared bits for the View-one-file / View-one-directory pages (files.mdx §4, directories.mdx §4):
// the two sticky-flag switches, and the "entity is gone" card.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import type { EntityView } from "@lfb/shared";
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
