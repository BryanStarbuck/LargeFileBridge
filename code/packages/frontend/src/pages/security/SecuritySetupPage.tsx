// The one-time, unauthenticated first-run Security Setup page (security.mdx §4). Shown by the
// <Root> gate (main.tsx) while GET /api/security/config returns configured:false — before anyone can
// sign in. Writes the allow-list once via POST /api/security/setup (loopback-guarded, one-time), then
// the gate advances to Google sign-in. After this, the page is never shown again (§3).
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { SecurityConfigPublic } from "@lfb/shared";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";
import {
  AllowListFields,
  isAllowListValid,
  cleanDomains,
  cleanEmails,
  type AllowListValue,
} from "../../components/AllowListFields.js";

export function SecuritySetupPage({ config }: { config: SecurityConfigPublic }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<AllowListValue>({
    allowCompanies: true,
    domains: [""],
    allowIndividuals: false,
    emails: [""],
  });

  const save = useMutation({
    mutationFn: () =>
      api.securitySetup({
        allowCompanies: value.allowCompanies,
        domains: cleanDomains(value.domains),
        allowIndividuals: value.allowIndividuals,
        emails: cleanEmails(value.emails),
      }),
    onSuccess: (r) => {
      if (r.restartRecommended) {
        toast.success("Saved. Restart the backend to finish enabling the new company domain(s).");
      } else {
        toast.success("Security configured — you can sign in now.");
      }
      // Advance the <Root> gate: security/config now reports configured:true.
      qc.invalidateQueries({ queryKey: ["securityConfig"] });
    },
    onError: (e: Error) => {
      clientLog.error("SecuritySetupPage.save", e);
      toast.error(e.message);
    },
  });

  const valid = isAllowListValid(value);

  return (
    <div className="grid h-full place-items-center overflow-y-auto bg-slate-50 p-6">
      <div className="w-full max-w-xl rounded-2xl border border-[var(--lfb-border)] bg-white p-8 shadow-sm">
        <div className="mb-1 flex items-center justify-center gap-2" style={{ color: "var(--lfb-primary)" }}>
          <ShieldCheck className="h-6 w-6" />
          <h1 className="text-xl font-semibold">{config.appName}</h1>
        </div>
        <p className="text-center text-sm font-medium text-black/70">
          Configure who can access this computer
        </p>
        <p className="mb-6 mt-2 text-center text-sm text-black/60">
          This is a one-time setup for this install. Choose who is allowed to sign in with Google. You
          can allow a whole company domain, a few individual Google accounts, or both.
        </p>

        <AllowListFields value={value} onChange={setValue} />

        <button
          type="button"
          disabled={!valid || save.isPending}
          onClick={() => save.mutate()}
          className="mt-6 w-full rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-white disabled:opacity-40"
        >
          {save.isPending ? "Saving…" : "Save & enable sign-in"}
        </button>
        <p className="mt-3 text-center text-xs text-black/50">
          Locked in after saving. To change it later, sign in and open Settings → Access (admin only).
        </p>
      </div>
    </div>
  );
}
