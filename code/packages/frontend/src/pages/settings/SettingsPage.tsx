// Global Settings (settings.mdx): the big-file threshold + scanner roots + IPFS node + allow-list link.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { GlobalSettings, SizeUnit } from "@lfb/shared";
import { SIZE_UNITS, toBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { CredentialsSetupCard } from "../../components/CredentialsSetupCard.js";

export function SettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const { data: auth } = useQuery({ queryKey: ["authConfig"], queryFn: api.authConfig });
  const [value, setValue] = useState(100);
  const [unit, setUnit] = useState<SizeUnit>("MB");
  const [roots, setRoots] = useState("");

  useEffect(() => {
    if (data) {
      setValue(data.bigFile.display.value);
      setUnit(data.bigFile.display.unit);
      setRoots(data.scannerRoots.join("\n"));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (p: Parameters<typeof api.patchSettings>[0]) => api.patchSettings(p),
    onSuccess: (d: GlobalSettings) => {
      qc.setQueryData(["settings"], d);
      toast.success("Settings saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!data) return <div className="text-black/50">Loading…</div>;

  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-2xl font-bold">Settings</h1>

      <div className="mb-5 rounded-lg border border-[var(--lfb-border)] p-4">
        <h2 className="mb-1 font-semibold">Big-file threshold</h2>
        <p className="mb-2 text-sm text-black/60">Files at or above this size are bridged over IPFS.</p>
        <div className="flex items-center gap-2">
          <input type="number" value={value} onChange={(e) => setValue(Number(e.target.value))}
            className="w-32 rounded border border-[var(--lfb-border)] px-2 py-1.5" />
          <select value={unit} onChange={(e) => setUnit(e.target.value as SizeUnit)}
            className="rounded border border-[var(--lfb-border)] px-2 py-1.5">
            {SIZE_UNITS.map((u) => <option key={u}>{u}</option>)}
          </select>
          <span className="text-xs text-black/50">= {toBytes(value, unit).toLocaleString()} bytes</span>
          <button onClick={() => save.mutate({ bigFile: { value, unit } })}
            className="ml-auto rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white">Save</button>
        </div>
      </div>

      <div className="mb-5 rounded-lg border border-[var(--lfb-border)] p-4">
        <h2 className="mb-1 font-semibold">Scanner roots</h2>
        <p className="mb-2 text-sm text-black/60">Top-level directories the scan walks to discover repos (one per line).</p>
        <textarea value={roots} onChange={(e) => setRoots(e.target.value)} rows={4}
          className="w-full rounded border border-[var(--lfb-border)] px-2 py-1.5 font-mono text-xs" />
        <button onClick={() => save.mutate({ scannerRoots: roots.split("\n").map((s) => s.trim()).filter(Boolean) })}
          className="mt-2 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white">Save roots</button>
      </div>

      <div className="mb-5 rounded-lg border border-[var(--lfb-border)] p-4">
        <h2 className="mb-1 font-semibold">IPFS node</h2>
        <dl className="text-sm text-black/70 space-y-1">
          <div>API: <code>{data.ipfs.apiAddr}</code></div>
          <div>Gateway: <code>{data.ipfs.gatewayAddr}</code></div>
          <div>Reprovide strategy: <b>{data.ipfs.reprovideStrategy}</b></div>
          <div>Health: <span className={data.ipfs.health === "ok" ? "text-green-700" : "text-red-600"}>{data.ipfs.health}</span></div>
          <div>Only-our-content compliant:{" "}
            <span className={data.ipfs.compliant ? "text-green-700" : "text-amber-600"}>
              {data.ipfs.compliant ? "yes" : "no — will be corrected on next sync"}
            </span>
          </div>
        </dl>
      </div>

      <div className="mb-5 rounded-lg border border-[var(--lfb-border)] p-4">
        <h2 className="mb-1 font-semibold">Authentication</h2>
        {auth?.oauthConfigured ? (
          <dl className="text-sm text-black/70 space-y-1">
            <div>
              Google OAuth: <span className="text-green-700">configured</span>
              {auth.credentialsFile.usingEnv
                ? " (from environment)"
                : ` (from ${auth.credentialsFile.filename})`}
            </div>
            <div>
              Credentials file: <code>{auth.credentialsFile.path}</code>
            </div>
          </dl>
        ) : auth ? (
          <div className="mt-2">
            <CredentialsSetupCard info={auth.credentialsFile} devAuth={auth.devAuth} />
          </div>
        ) : (
          <p className="text-sm text-black/50">Loading…</p>
        )}
      </div>

      <div className="rounded-lg border border-[var(--lfb-border)] p-4">
        <h2 className="mb-1 font-semibold">Access</h2>
        <p className="text-sm text-black/60">
          {data.access.allowCompanies ? data.access.allowedDomains.length : 0} company domain(s),{" "}
          {data.access.allowIndividuals ? data.access.allowedEmails.length : 0} individual account(s)
          allowed.{" "}
          <Link to="/settings/allow-list" className="text-[var(--lfb-primary)]">Manage access →</Link>
        </p>
      </div>
    </div>
  );
}
