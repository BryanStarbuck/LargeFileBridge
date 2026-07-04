// Settings → Access — the admin-only return-visit editor for the security allow-list (security.mdx
// §10). Same two sections as the first-run setup page (companies + individuals), backed by
// GET/PATCH /api/settings/security. Gated to role:admin in the router + backend.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import type { SecurityAccess } from "@lfb/shared";
import { api } from "../../api/client.js";
import { clientLog } from "../../lib/clientLog.js";
import {
  AllowListFields,
  isAllowListValid,
  cleanDomains,
  cleanEmails,
  type AllowListValue,
} from "../../components/AllowListFields.js";

function toValue(a: SecurityAccess): AllowListValue {
  return {
    allowCompanies: a.allowCompanies,
    domains: a.allowedDomains.length ? a.allowedDomains : [""],
    allowIndividuals: a.allowIndividuals,
    emails: a.allowedEmails.length ? a.allowedEmails : [""],
  };
}

export function AllowListPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["security"], queryFn: api.security });
  const [value, setValue] = useState<AllowListValue>({
    allowCompanies: false,
    domains: [""],
    allowIndividuals: false,
    emails: [""],
  });
  useEffect(() => {
    if (data) setValue(toValue(data));
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api.setSecurity({
        allowCompanies: value.allowCompanies,
        domains: cleanDomains(value.domains),
        allowIndividuals: value.allowIndividuals,
        emails: cleanEmails(value.emails),
      }),
    onSuccess: (r) => {
      qc.setQueryData(["security"], r.access);
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast.success(
        r.restartRecommended
          ? "Saved. Restart the backend to finish enabling the new company domain(s)."
          : "Access saved",
      );
    },
    onError: (e: Error) => {
      clientLog.error("AllowListPage.save", e);
      toast.error(e.message);
    },
  });

  const valid = isAllowListValid(value);

  return (
    <div className="max-w-xl">
      <Link to="/settings" className="flex items-center gap-1 text-sm text-black/50 hover:text-black">
        <ChevronLeft className="h-4 w-4" /> Settings
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold">Access</h1>
      <p className="mb-4 text-sm text-black/60">
        Who may sign in to this install. Allow a whole company domain, individual Google accounts, or
        both. Admin only.
      </p>

      <AllowListFields value={value} onChange={setValue} />

      <button
        type="button"
        disabled={!valid || save.isPending}
        onClick={() => save.mutate()}
        className="mt-4 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white disabled:opacity-40"
      >
        {save.isPending ? "Saving…" : "Save"}
      </button>
      {!valid && (
        <p className="mt-2 text-xs text-amber-600">
          Allow at least one company domain or individual account — an empty list would lock everyone out.
        </p>
      )}
    </div>
  );
}
