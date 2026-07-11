// The "Git ignore" pop-over dialog (git_ignore.mdx §1/§3/§6). A darkened-backdrop modal (never
// window.confirm) that plans the exact anchored, repo-root-relative .gitignore lines for the target set,
// previews them live, and — on Apply — writes them into each owning repo's .gitignore, lighting up the new
// "I" git-ignored badge. Git-side twin of CompressInsideDialog: same bg-black/40 pop-over shape + bus.
//
// LOCKED shape (§3): adaptive summary (one file / N files / N folders / D folders + F files) + the owning
// repo name(s); a Recursive checkbox rendered ONLY when the plan has directories (default OFF); a read-only
// monospace preview grouped by repo; muted "already ignored" / "not in a git repo" notes; a Cancel link to
// the LEFT of a single blue-fill primary button that reads "Apply Git ignore ›" / "Recursive apply ›".
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, Loader2 } from "lucide-react";
import { api } from "@/api/client";
import { clientLog } from "../../lib/clientLog.js";
import type { GitIgnoreRequestUi } from "../../lib/gitIgnore.js";

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

// The adaptive summary shape (git_ignore.mdx §3): one file / N files / N folders / D folders + F files.
function shapeLabel(files: number, dirs: number): string {
  const parts: string[] = [];
  if (dirs > 0) parts.push(`${dirs} folder${plural(dirs)}`);
  if (files > 0) parts.push(`${files} file${plural(files)}`);
  return parts.length ? parts.join(" + ") : "nothing";
}

export function GitIgnoreDialog({
  req,
  onClose,
}: {
  req: GitIgnoreRequestUi;
  onClose: () => void;
}) {
  const [recursive, setRecursive] = useState(false); // §3 — default OFF (deliberately unlike compress)
  const cancelRef = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Plan (git_ignore.mdx §5) — recomputed whenever `recursive` toggles (the folder lines change shape).
  const plan = useQuery({
    queryKey: ["git-ignore", "plan", req.paths ?? null, req.root ?? null, recursive],
    queryFn: () => api.gitIgnorePlan({ paths: req.paths, root: req.root, recursive }),
  });

  const apply = useMutation({
    mutationFn: () => api.gitIgnoreApply({ paths: req.paths, root: req.root, recursive }),
    onSuccess: (res) => {
      // §6 — one honest toast (never a silent no-op).
      if (res.written === 0) {
        toast.info("Nothing to git-ignore — all already ignored");
      } else {
        toast.success(
          res.written === 1 ? "1 path git-ignored" : `${res.written} paths git-ignored`,
        );
      }
      // The "I" badge turns on without a rescan (§6): invalidate the FS listings + entity views.
      qc.invalidateQueries({ queryKey: ["fs"] });
      qc.invalidateQueries({ queryKey: ["entity"] });
      qc.invalidateQueries({ queryKey: ["entity-menu"] });
      onClose();
    },
    onError: (e: Error) => {
      clientLog.error("GitIgnoreDialog.apply", e);
      toast.error(e.message || "Couldn’t write .gitignore");
    },
  });

  const close = () => {
    if (apply.isPending) return; // don't dismiss mid-write
    onClose();
  };

  const p = plan.data;
  const totalLines = p ? p.linesByRepo.reduce((n, g) => n + g.lines.length, 0) : 0;
  const multiRepo = (p?.linesByRepo.length ?? 0) > 1;
  const canApply = !!p && totalLines > 0 && !apply.isPending;

  // Summary line (§3): the selection shape + the owning repo name(s).
  const repoPart = p
    ? p.linesByRepo.length === 1
      ? `repo ${p.linesByRepo[0].repoName}`
      : p.linesByRepo.length > 1
        ? `${p.linesByRepo.length} repos`
        : ""
    : "";
  const summary = p ? [shapeLabel(p.files, p.dirs), repoPart].filter(Boolean).join("  ·  ") : "";

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={close}>
      <div
        className="w-[36rem] max-w-full rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-ignore-title"
      >
        <div className="flex items-center gap-2 text-[var(--lfb-primary)]">
          <Ban className="h-5 w-5" />
          <h2 id="git-ignore-title" className="text-lg font-semibold text-black/80">
            Git ignore
          </h2>
        </div>
        {summary && <div className="mt-1 text-xs text-black/50">{summary}</div>}

        {plan.isPending && (
          <div className="mt-5 flex items-center gap-2 text-sm text-black/50">
            <Loader2 className="h-4 w-4 animate-spin" /> Planning…
          </div>
        )}
        {plan.isError && (
          <div className="mt-5 text-sm text-[var(--lfb-bad)]">
            {(plan.error as Error)?.message || "Couldn’t plan the .gitignore lines"}
          </div>
        )}

        {p && (
          <div className="mt-5 space-y-3 text-sm text-black">
            {/* Recursive — shown ONLY when a directory is in the set (§3); default OFF. */}
            {p.dirs > 0 && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={(e) => setRecursive(e.target.checked)}
                  className="mt-0.5"
                />
                <span>Recursive — ignore the whole folder and everything under it.</span>
              </label>
            )}

            {/* Preview — the exact .gitignore lines, grouped by repo when >1 (§3/§5). */}
            <div>
              <div className="mb-1 text-xs text-black/50">These lines will be added to .gitignore:</div>
              <div className="max-h-56 overflow-auto rounded-lg border border-[var(--lfb-border)] bg-black/[0.02] p-3 font-mono text-xs leading-relaxed text-black">
                {totalLines === 0 ? (
                  <div className="text-black/40">Nothing to add.</div>
                ) : (
                  p.linesByRepo.map((g) => (
                    <div key={g.repo} className="mb-1 last:mb-0">
                      {multiRepo && (
                        <div className="text-black/40"># {g.repoName}/.gitignore</div>
                      )}
                      {g.lines.map((line, i) => (
                        <div key={`${g.repo}-${i}`} className="whitespace-pre">
                          {line}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Skip notes (§3) — muted, only when non-zero. */}
            {p.alreadyIgnored > 0 && (
              <div className="text-xs text-black/50">
                {p.alreadyIgnored} path{plural(p.alreadyIgnored)} already ignored — skipped.
              </div>
            )}
            {p.notInRepo > 0 && (
              <div className="text-xs text-black/50">
                {p.notInRepo} not in a git repo — can’t be git-ignored.
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-4">
          <button
            ref={cancelRef}
            onClick={close}
            disabled={apply.isPending}
            className="text-sm text-[var(--lfb-primary)] hover:underline disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={() => apply.mutate()}
            disabled={!canApply}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {apply.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {recursive ? "Recursive apply ›" : "Apply Git ignore ›"}
          </button>
        </div>
      </div>
    </div>
  );
}
