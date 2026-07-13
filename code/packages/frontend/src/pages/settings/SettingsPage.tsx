// Global Settings (settings.mdx + use_cases.mdx §5.3 + UC-7). Each configurable area reports its own
// health (Authentication, IPFS node), so the user can see at a glance whether they set things up
// right. Raw values (addresses, reprovide strategy) live behind a chevron; the plain-English state is
// the headline. The big-file threshold + scanner-roots editors are unchanged.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { GlobalSettings, SizeUnit, CompressMediaPrefs, CompressQuality, DescribeAiProviderConfig } from "@lfb/shared";
import { SIZE_UNITS, toBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { CredentialsSetupCard } from "../../components/CredentialsSetupCard.js";
import { TranscriptionSettingsSection } from "./TranscriptionSettingsSection.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { Section } from "../../components/ui/Section.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { healthColor } from "../../components/ui/health.js";
import { clientLog } from "../../lib/clientLog.js";

export function SettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const { data: auth } = useQuery({ queryKey: ["authConfig"], queryFn: api.authConfig });
  const [value, setValue] = useState(100);
  const [unit, setUnit] = useState<SizeUnit>("MB");
  const [roots, setRoots] = useState("");
  const [corePct, setCorePct] = useState(90); // parallelism knob (parallelization.mdx §4)

  useEffect(() => {
    if (data) {
      setValue(data.bigFile.display.value);
      setUnit(data.bigFile.display.unit);
      setRoots(data.scannerRoots.join("\n"));
      setCorePct(Math.round(data.performance.maxCoreFraction * 100));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (p: Parameters<typeof api.patchSettings>[0]) => api.patchSettings(p),
    onSuccess: (d: GlobalSettings) => {
      qc.setQueryData(["settings"], d);
      toast.success("Settings saved");
    },
    onError: (e: Error) => {
      clientLog.error("SettingsPage.save", e);
      toast.error(e.message);
    },
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
        title="Parallelism"
        subtitle="How much of the CPU LargeFileBridge may use for background compression & processing. Higher = faster bulk runs; lower keeps more headroom for other apps."
      >
        <div className="flex items-center gap-3">
          <input type="range" min={10} max={100} step={5} value={corePct}
            onChange={(e) => setCorePct(Number(e.target.value))} className="w-56" />
          <span className="w-12 text-sm tabular-nums">{corePct}%</span>
          {data && (
            <span className="text-xs text-black/50">
              ≈ {Math.max(1, Math.round((data.performance.cores * corePct) / 100))} of {data.performance.cores} cores
            </span>
          )}
          <button onClick={() => save.mutate({ performance: { maxCoreFraction: corePct / 100 } })}
            className="ml-auto rounded-md bg-[var(--lfb-primary)] px-3 py-1.5 text-sm text-white">Save</button>
        </div>
        <p className="mt-2 text-xs text-black/50">
          Tunes background compression, fingerprinting & batch transcription (the mass-compute budget).
          Pinning and scans always keep 2 cores free and aren't affected.
        </p>
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
              : "This computer is serving more than your own content. It will be corrected on the next pin (or fix it now from the IPFS page)."}
        </p>
        <div className="mt-2 flex gap-4">
          <Link to="/ipfs" className="text-sm text-[var(--lfb-primary)]">Open IPFS →</Link>
          <Link to="/tools" className="text-sm text-[var(--lfb-primary)]">Command-line tools →</Link>
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

      <CompressionSettingsSection />

      <TranscriptionSettingsSection />

      <AiProvidersSection />
    </div>
  );
}

// ── AI description providers (ai_description.mdx §5/§6) — API keys + default provider ────────────────
function AiProvidersSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["ai-config"], queryFn: api.aiConfig });
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.setAiConfig>[0]) => api.setAiConfig(patch),
    onSuccess: (d) => {
      qc.setQueryData(["ai-config"], d);
      qc.invalidateQueries({ queryKey: ["describe-providers"] });
      toast.success("AI settings saved");
    },
    onError: (e: Error) => { clientLog.error("Settings.aiConfig", e); toast.error(e.message); },
  });
  if (!data) return null;

  return (
    <Section
      title="AI description providers"
      subtitle="Vision models used to describe images & videos. Keys stay on this computer (config.yaml or environment). Only Gemini describes video."
    >
      <label className="mb-3 flex items-center gap-2 text-sm">
        Default provider
        <select
          className="rounded border border-[var(--lfb-border)] px-2 py-1"
          value={data.provider}
          onChange={(e) => save.mutate({ provider: e.target.value as typeof data.provider })}
        >
          <option value="auto">Auto (first available)</option>
          {data.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <div className="space-y-3">
        {data.providers.map((p) => <AiProviderRow key={p.id} p={p} onSave={(patch) => save.mutate({ [p.id]: patch })} />)}
      </div>
      <p className="mt-2 text-xs text-black/50">
        A key set here is stored in <code>config.yaml</code>. Leave a field blank to fall back to the
        environment variable (<code>GEMINI_API_KEY</code> / <code>XAI_API_KEY</code> / <code>OPENAI_API_KEY</code>).
      </p>
    </Section>
  );
}

function AiProviderRow({ p, onSave }: { p: DescribeAiProviderConfig; onSave: (patch: { apiKey?: string; model?: string }) => void }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(p.model);
  useEffect(() => { setModel(p.model); }, [p.model]);
  const status = p.available ? (p.usingEnv ? "from env" : "configured") : "no key";
  return (
    <div className="rounded-md border border-[var(--lfb-border)] p-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className="w-32 font-medium">{p.label}</span>
        <span className="w-24" style={{ color: healthColor(p.available ? "ok" : "warn") }}>
          {p.available ? "● " : "✗ "}{status}
        </span>
        <span className="text-xs text-black/45">describes {p.supports.join(" + ")}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <input
          type="password"
          placeholder={p.hasConfigKey ? "•••••••• (stored — type to replace)" : "API key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="w-64 rounded border border-[var(--lfb-border)] px-2 py-1 font-mono text-xs"
        />
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-40 rounded border border-[var(--lfb-border)] px-2 py-1 font-mono text-xs"
          title="Model id"
        />
        <button
          onClick={() => { onSave({ ...(key ? { apiKey: key } : {}), model }); setKey(""); }}
          className="rounded-md bg-[var(--lfb-primary)] px-3 py-1 text-white"
        >
          Save
        </button>
        {p.hasConfigKey && (
          <button
            onClick={() => onSave({ apiKey: "" })}
            className="rounded-md border border-[var(--lfb-border)] px-3 py-1 text-black/60"
            title="Clear the stored key (fall back to env)"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

// ── Compression (compression.mdx §7) — per-media codec allow/deny + quality ─────────────────────────
const QUALITIES: CompressQuality[] = ["low", "medium", "high", "lossless"];

function CompressionSettingsSection() {
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ["compress-settings"], queryFn: api.compressSettings });
  const { data: tools } = useQuery({ queryKey: ["compress-tools"], queryFn: api.compressTools });
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.setCompressSettings>[0]) => api.setCompressSettings(patch),
    onSuccess: (ns) => { qc.setQueryData(["compress-settings"], ns); toast.success("Compression settings saved"); },
    onError: (e: Error) => { clientLog.error("Settings.compress", e); toast.error(e.message); },
  });
  if (!s) return null;
  const missing = tools ? Object.entries(tools).filter(([, v]) => !v).map(([k]) => k) : [];

  return (
    <Section title="Compression" subtitle="Per-media codec preferences. Medium quality, resolution always preserved. Deny codecs some social sites don't support.">
      {(["images", "video"] as const).map((m) => (
        <MediaPrefRow key={m} media={m} prefs={s[m]} onSave={(patch) => save.mutate({ [m]: { ...s[m], ...patch } })} />
      ))}
      <p className="mt-2 text-xs text-black/50">Audio compression is disabled for now (planned later).</p>
      {tools && missing.length > 0 && (
        <p className="mt-1 text-xs text-amber-700">
          Tools not installed: {missing.join(", ")} — <code>brew install ffmpeg imagemagick libheif oxipng webp mozjpeg</code>
        </p>
      )}
    </Section>
  );
}

// Recognized extensions per media type (mirrors @lfb/shared media.ts IMAGE_EXT / VIDEO_EXT). Each row is a
// per-extension IN-SCOPE checkbox (images.mdx §2.2); an unchecked box adds the ext to skipExts (opt-OUT).
// `convertLabel` is the "→ JPEG" / "→ H.264" hint shown when convert_types is ON.
const IMAGE_SCOPE_EXTS = [".heic", ".heif", ".avif", ".png", ".bmp", ".tiff", ".gif", ".jpg", ".jpeg", ".webp"];
const VIDEO_SCOPE_EXTS = [".mov", ".mp4", ".avi", ".mkv", ".webm", ".m4v", ".mpg", ".wmv", ".flv"];
function convertLabel(media: "images" | "video", ext: string): string {
  if (media === "images") return ext === ".jpg" || ext === ".jpeg" || ext === ".webp" ? "re-encode" : "→ JPEG";
  return ext === ".mp4" ? "re-encode" : "→ H.264";
}

function MediaPrefRow({ media, prefs, onSave }: { media: "images" | "video"; prefs: CompressMediaPrefs; onSave: (patch: Partial<CompressMediaPrefs>) => void }) {
  const [prefer, setPrefer] = useState(prefs.prefer.join(", "));
  const [deny, setDeny] = useState(prefs.deny.join(", "));
  const parse = (s: string) => s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const scopeExts = media === "images" ? IMAGE_SCOPE_EXTS : VIDEO_SCOPE_EXTS;
  const skip = new Set(prefs.skipExts);
  const toggleExt = (ext: string, inScope: boolean) => {
    // inScope (checked) → ensure NOT in skipExts; unchecked → add to skipExts.
    const next = new Set(prefs.skipExts);
    if (inScope) next.delete(ext);
    else next.add(ext);
    onSave({ skipExts: [...next] });
  };
  return (
    <div className="mb-3 rounded-md border border-[var(--lfb-border)] p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="w-16 font-medium capitalize">{media}</span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={prefs.enabled} onChange={(e) => onSave({ enabled: e.target.checked })} /> Enabled
        </label>
        <label className="flex items-center gap-1.5">
          Quality
          <select className="rounded border border-[var(--lfb-border)] px-1 py-0.5" value={prefs.quality} onChange={(e) => onSave({ quality: e.target.value as CompressQuality })}>
            {QUALITIES.map((q) => <option key={q} value={q}>{q}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5" title="When on, a compress may change the format to a better/compatible target (HEIC → JPEG, PNG → JPEG). Off = format-preserving.">
          <input type="checkbox" checked={prefs.convertTypes} onChange={(e) => onSave({ convertTypes: e.target.checked })} /> Convert file types
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-1.5">
          Prefer
          <input className="w-48 rounded border border-[var(--lfb-border)] px-1 py-0.5" value={prefer}
            onChange={(e) => setPrefer(e.target.value)} onBlur={() => onSave({ prefer: parse(prefer) })}
            title="Ordered target codecs; first allowed + available wins" />
        </label>
        <label className="flex items-center gap-1.5">
          Deny
          <input className="w-40 rounded border border-[var(--lfb-border)] px-1 py-0.5" value={deny}
            onChange={(e) => setDeny(e.target.value)} onBlur={() => onSave({ deny: parse(deny) })}
            title="Codecs never chosen (e.g. jpeg2000, av1)" />
        </label>
      </div>
      <div className="mt-2">
        <div className="mb-1 text-xs text-black/50">Compress these {media} types (uncheck to skip an extension):</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {scopeExts.map((ext) => {
            const inScope = !skip.has(ext);
            return (
              <label key={ext} className="flex items-center gap-1" title={prefs.convertTypes ? `${ext} ${convertLabel(media, ext)}` : `${ext} re-encode in place`}>
                <input type="checkbox" checked={inScope} onChange={(e) => toggleExt(ext, e.target.checked)} />
                <span className="font-mono">{ext}</span>
                {prefs.convertTypes && <span className="text-black/40">{convertLabel(media, ext)}</span>}
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
