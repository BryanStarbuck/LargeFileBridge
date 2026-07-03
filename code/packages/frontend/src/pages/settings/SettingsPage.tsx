// Global Settings (settings.mdx + use_cases.mdx §5.3 + UC-7). Each configurable area reports its own
// health (Authentication, IPFS node), so the user can see at a glance whether they set things up
// right. Raw values (addresses, reprovide strategy) live behind a chevron; the plain-English state is
// the headline. The big-file threshold + scanner-roots editors are unchanged.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { GlobalSettings, SizeUnit } from "@lfb/shared";
import { SIZE_UNITS, toBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { CredentialsSetupCard } from "../../components/CredentialsSetupCard.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { Section } from "../../components/ui/Section.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { healthColor } from "../../components/ui/health.js";

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

  const ipfsOk = data.ipfs.health === "ok";
  const ipfsState = !ipfsOk ? "bad" : data.ipfs.compliant ? "ok" : "warn";
  const authConfigured = !!auth?.oauthConfigured;

  return (
    <div className="max-w-2xl">
      <PageHeader title="Settings" />

      <Section
        title="Big-file threshold"
        subtitle="Files at or above this size are bridged over IPFS instead of committed to git."
      >
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
      </Section>

      <Section
        title="Scanner roots"
        subtitle="Top-level directories the scan walks to discover repos (one per line)."
      >
        <textarea value={roots} onChange={(e) => setRoots(e.target.value)} rows={4}
          className="w-full rounded border border-[var(--lfb-border)] px-2 py-1.5 font-mono text-xs" />
        <button onClick={() => save.mutate({ scannerRoots: roots.split("\n").map((s) => s.trim()).filter(Boolean) })}
          className="mt-2 rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white">Save roots</button>
      </Section>

      <Section
        title="Authentication"
        state={authConfigured ? "ok" : "bad"}
        right={
          <span style={{ color: healthColor(authConfigured ? "ok" : "bad") }}>
            {authConfigured ? "Configured" : "Not configured"}
          </span>
        }
      >
        {authConfigured ? (
          <div className="text-sm text-black/70">
            <p className="mb-2">
              Google sign-in is set up
              {auth!.credentialsFile.usingEnv ? " (from environment variables)." : ` (from ${auth!.credentialsFile.filename}).`}
            </p>
            <Disclosure label="Credentials details">
              <div>
                Credentials file: <code className="text-xs">{auth!.credentialsFile.path}</code>
              </div>
            </Disclosure>
          </div>
        ) : auth ? (
          <div>
            <p className="mb-2 text-sm text-black/60">
              Sign-in won't work until Google OAuth credentials are in place.
            </p>
            <CredentialsSetupCard info={auth.credentialsFile} devAuth={auth.devAuth} />
          </div>
        ) : (
          <p className="text-sm text-black/50">Loading…</p>
        )}
      </Section>

      <Section
        title="IPFS node"
        state={ipfsState}
        right={
          <span style={{ color: healthColor(ipfsState) }}>
            {!ipfsOk ? "Unreachable" : data.ipfs.compliant ? "Serving only your content" : "Needs a fix"}
          </span>
        }
      >
        <p className="text-sm text-black/70">
          {!ipfsOk
            ? "The IPFS engine isn't answering. Start it from the IPFS page so your files can move."
            : data.ipfs.compliant
              ? "This computer serves only your own content — it is not a public gateway for the internet. This is the secure default."
              : "This computer is serving more than your own content. It will be corrected on the next sync (or fix it now from the IPFS page)."}
        </p>
        <div className="mt-2">
          <Link to="/ipfs" className="text-sm text-[var(--lfb-primary)]">Open IPFS →</Link>
        </div>
        <div className="mt-2">
          <Disclosure label="Node addresses & policy">
            <dl className="space-y-1 text-sm text-black/70">
              <div>API: <code className="text-xs">{data.ipfs.apiAddr}</code></div>
              <div>Gateway: <code className="text-xs">{data.ipfs.gatewayAddr}</code></div>
              <div>Reprovide strategy: <b>{data.ipfs.reprovideStrategy}</b></div>
              <div>Public gateway opt-out: <b>{data.ipfs.publicGateway ? "yes" : "no"}</b></div>
            </dl>
          </Disclosure>
        </div>
      </Section>

      <Section title="Access" subtitle="Who may sign in to this install.">
        <p className="text-sm text-black/60">
          {data.access.allowCompanies ? data.access.allowedDomains.length : 0} company domain(s),{" "}
          {data.access.allowIndividuals ? data.access.allowedEmails.length : 0} individual account(s)
          allowed.{" "}
          <Link to="/settings/allow-list" className="text-[var(--lfb-primary)]">Manage access →</Link>
        </p>
      </Section>
    </div>
  );
}
