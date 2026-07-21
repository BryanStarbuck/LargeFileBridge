// The "Review company repo mappings" page (repo_owner_propagation.mdx §4). A teammate asserted (on their
// computer) that some repos belong to a company; the assertion travelled in `<syncRepo>/owner_map.yaml` and
// on THIS computer became a set of PENDING mappings. Moving a repo to the company redirects this member's
// Large File Bridge tracking state into the SHARED company repo, so it must NEVER be applied silently — this
// page is the explicit consent gate (§5). Each pending repo is one row with a checkbox (default CHECKED) and
// a two-radio Move-to-company / Keep-personal choice (default Move to company). A row is "accepted" only when
// checked AND Move to company; it is "declined" if unchecked OR Keep personal (§4.1). A single primary
// "Continue & apply ›" button POSTs the batch, then routes back to the main view with a summary toast (§4.2/§4.3).
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, Building2 } from "lucide-react";
import { toast } from "sonner";
import type { PendingCompanyMapping, CompanyMappingSelection, CompanyMappingApplyResult } from "@lfb/shared";
import { http, unwrap } from "../../api/axios.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { PageSkeleton } from "../../components/ui/PageSkeleton.js";
import { useLiveRefresh } from "../../lib/useLiveRefresh.js";
import { clientLog } from "../../lib/clientLog.js";

// GET the pending mappings (repo_owner_propagation.mdx §3) and POST the batch of per-row selections (§4.3).
// These endpoints aren't on the shared `api` client object, so the two calls live here against the same
// axios instance + { ok, data } envelope unwrapper every other call uses.
function fetchPending(): Promise<PendingCompanyMapping[]> {
  return unwrap<PendingCompanyMapping[]>(http.get("/company-mappings/pending"));
}
function applyMappings(selections: CompanyMappingSelection[]): Promise<CompanyMappingApplyResult> {
  return unwrap<CompanyMappingApplyResult>(http.post("/company-mappings/apply", selections));
}

// One row's live choice. `checked` = included in the apply; `decision` = the two-radio choice. Both default
// to "company" (checked + Move to company) on load (§4.1 — the cooperative default).
interface RowChoice {
  checked: boolean;
  decision: "company" | "personal";
}

export function CompanyMappingReviewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: pending = [], isLoading } = useQuery({
    queryKey: ["company-mappings", "pending"],
    queryFn: fetchPending,
  });
  useLiveRefresh(["storages", "repos"], [["company-mappings", "pending"]]);

  // Per-repo choice state, keyed by repoId. Initialized to the default (checked + company) for every pending
  // row the first time it appears; existing choices are preserved across refetches.
  const [choices, setChoices] = useState<Record<string, RowChoice>>({});
  useEffect(() => {
    setChoices((prev) => {
      const next = { ...prev };
      for (const p of pending) {
        if (!next[p.repoId]) next[p.repoId] = { checked: true, decision: "company" };
      }
      return next;
    });
  }, [pending]);

  const choiceFor = (repoId: string): RowChoice => choices[repoId] ?? { checked: true, decision: "company" };
  const setRow = (repoId: string, patch: Partial<RowChoice>) =>
    setChoices((prev) => ({ ...prev, [repoId]: { ...choiceFor(repoId), ...patch } }));

  // Group the pending rows by asserting company so each company gets its own header (§4 — keep it simple).
  const groups = useMemo(() => {
    const byCompany = new Map<string, { companyName: string; assertedBy: string; rows: PendingCompanyMapping[] }>();
    for (const p of pending) {
      const g = byCompany.get(p.companyId);
      if (g) g.rows.push(p);
      else byCompany.set(p.companyId, { companyName: p.companyName, assertedBy: p.assertedBy, rows: [p] });
    }
    return [...byCompany.values()];
  }, [pending]);

  const apply = useMutation({
    mutationFn: () => {
      // A row is accepted only when checked AND Move to company; otherwise it's declined (§4.1).
      const selections: CompanyMappingSelection[] = pending.map((p) => {
        const c = choiceFor(p.repoId);
        return { repoId: p.repoId, decision: c.checked && c.decision === "company" ? "company" : "personal" };
      });
      return applyMappings(selections);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["company-mappings", "pending"] });
      qc.invalidateQueries({ queryKey: ["repos"] });
      qc.invalidateQueries({ queryKey: ["storages"] });
      const parts: string[] = [];
      if (r.accepted > 0) parts.push(`${r.accepted} moved to the company`);
      if (r.declined > 0) parts.push(`${r.declined} kept personal`);
      if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
      toast.success(parts.length ? `Applied: ${parts.join(", ")}` : "Nothing to apply");
      navigate({ to: "/" });
    },
    onError: (e: Error) => {
      clientLog.error("CompanyMappingReviewPage.apply", e);
      toast.error(e.message);
    },
  });

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Review company repo mappings" />
        <PageSkeleton />
      </div>
    );
  }

  // Empty state (§4): nothing pending — a brief line and a link back to the main view.
  if (pending.length === 0) {
    return (
      <div>
        <PageHeader title="Review company repo mappings" />
        <div className="mt-10 rounded-lg border border-[var(--lfb-border)] bg-white p-8 text-center text-black/60">
          No company mappings to review.
          <div className="mt-3">
            <button
              onClick={() => navigate({ to: "/" })}
              className="text-sm font-medium text-[var(--lfb-primary)] hover:underline"
            >
              Back to Repos
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Review company repo mappings"
        subtitle="Choose what happens on THIS computer. Moving a repo to the company means its Large File Bridge tracking state will sync into the shared company repo."
      />

      <div className="mt-4 space-y-6">
        {groups.map((g) => (
          <div key={g.companyName} className="rounded-lg border border-[var(--lfb-border)] bg-white">
            {/* Per-company header — who asserted it and which company (repo_owner_propagation.mdx §4). */}
            <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--lfb-border)" }}>
              <Building2 className="h-4 w-4 text-[var(--lfb-primary)]" />
              <p className="text-sm text-black/80">
                <span className="font-medium text-black">{g.assertedBy}</span> asserted that these repos belong to{" "}
                <span className="font-medium text-black">{g.companyName}</span>.
              </p>
            </div>

            {/* One row per pending repo: two-radio choice (left) + checkbox + repo name / remote / assertedBy. */}
            <div className="divide-y" style={{ borderColor: "var(--lfb-border)" }}>
              {g.rows.map((p) => {
                const c = choiceFor(p.repoId);
                return (
                  <div key={p.repoId} className="flex items-center gap-4 px-4 py-3">
                    {/* The two-radio Move to company / Keep personal choice (§4.1). */}
                    <div className="flex w-40 shrink-0 flex-col gap-1 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`decision-${p.repoId}`}
                          checked={c.decision === "company"}
                          onChange={() => setRow(p.repoId, { decision: "company" })}
                        />
                        <span className={c.decision === "company" ? "text-black" : "text-black/60"}>Move to company</span>
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`decision-${p.repoId}`}
                          checked={c.decision === "personal"}
                          onChange={() => setRow(p.repoId, { decision: "personal" })}
                        />
                        <span className={c.decision === "personal" ? "text-black" : "text-black/60"}>Keep personal</span>
                      </label>
                    </div>

                    {/* Include checkbox (default CHECKED) — unchecking declines the row (§4.1). */}
                    <input
                      type="checkbox"
                      checked={c.checked}
                      onChange={(e) => setRow(p.repoId, { checked: e.target.checked })}
                      title="Include this repo in the apply"
                      className="h-4 w-4 shrink-0"
                    />

                    {/* Repo name · remote · asserted by. */}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-black">{p.repoName}</div>
                      <div className="truncate text-xs text-black/50">{p.remoteKey}</div>
                    </div>
                    <div className="hidden shrink-0 text-xs text-black/50 sm:block">{p.assertedBy}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* The single primary batch button — Continue & apply › (page_actions.mdx button style; §4.2). */}
      <div className="mt-6 flex justify-end">
        <button
          onClick={() => apply.mutate()}
          disabled={apply.isPending}
          className="flex items-center gap-1 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {apply.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Continue &amp; apply <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
