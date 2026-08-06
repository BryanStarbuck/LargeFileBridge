// Global Settings (settings.mdx + use_cases.mdx §5.3 + UC-7). Each configurable area reports its own
// health (Authentication, IPFS node), so the user can see at a glance whether they set things up
// right. Raw values (addresses, reprovide strategy) live behind a chevron; the plain-English state is
// the headline. The big-file threshold + scanner-roots editors are unchanged.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { GlobalSettings, SizeUnit, PersonalAccount, CompressMediaPrefs, CompressionSettings, CompressQuality, DescribeAiProviderConfig } from "@lfb/shared";
import { SIZE_UNITS, toBytes } from "@lfb/shared";
import { api } from "../../api/client.js";
import { CredentialsSetupCard } from "../../components/CredentialsSetupCard.js";
import { TranscriptionSettingsSection } from "./TranscriptionSettingsSection.js";
import { PageHeader } from "../../components/ui/PageHeader.js";
import { PageSkeleton } from "../../components/ui/PageSkeleton.js";
import { Section } from "../../components/ui/Section.js";
import { Disclosure } from "../../components/ui/Disclosure.js";
import { healthColor } from "../../components/ui/health.js";
import { useLiveRefresh } from "../../lib/useLiveRefresh.js";
import { clientLog } from "../../lib/clientLog.js";

export function SettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  useLiveRefresh(["settings"], [["settings"], ["ai-config"], ["compress-settings"]]);
  const { data: auth } = useQuery({ queryKey: ["authConfig"], queryFn: api.authConfig });
  const [value, setValue] = useState(100);
  const [unit, setUnit] = useState<SizeUnit>("MB");
  const [roots, setRoots] = useState("");
  const [personalAccts, setPersonalAccts] = useState(""); // one per line: "host/owner" or bare "owner"
  const [corePct, setCorePct] = useState(90); // parallelism knob (parallelization.mdx §4)

  useEffect(() => {
    if (data) {
      setValue(data.bigFile.display.value);
      setUnit(data.bigFile.display.unit);
      setRoots(data.scannerRoots.join("\n"));
      setPersonalAccts(data.personalAccounts.map((a) => (a.host ? `${a.host}/${a.owner}` : a.owner)).join("\n"));
      setCorePct(Math.round(data.performance.maxCoreFraction * 100));
    }
  }, [data]);

  // Parse the textarea into PersonalAccount[] (repo_company_mapping.mdx §4). A line "github.com/you" pins the
  // host; a bare line "you" matches that owner on any known forge host.
  const parsePersonalAccounts = (text: string): PersonalAccount[] =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const slash = l.indexOf("/");
        return slash > 0
          ? { host: l.slice(0, slash).trim(), owner: l.slice(slash + 1).trim() }
          : { owner: l };
      })
      .filter((a) => a.owner.length > 0);

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

  // Shell-first (performance.mdx Aspect 6b): the page never blocks on the server — the header paints
  // now and the sections fill in when the data lands.
  if (!data) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Settings" />
        <PageSkeleton blocks={4} />
      </div>
    );
  }

  const ipfsOk = data.ipfs.health === "ok";
  // A compliant CONFIG the running daemon hasn't read yet is NOT "serving only your content" (ipfs.mdx
  // §3.1.1) — until it restarts this computer is still relaying strangers' traffic. Amber, and it says so.
  const ipfsPendingRestart = ipfsOk && data.ipfs.compliant && data.ipfs.restartRequired;
  const ipfsState = !ipfsOk ? "bad" : data.ipfs.compliant && !ipfsPendingRestart ? "ok" : "warn";
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
            className="lfb-input w-32 px-2 py-1.5" />
          <select value={unit} onChange={(e) => setUnit(e.target.value as SizeUnit)}
            className="lfb-input px-2 py-1.5">
            {SIZE_UNITS.map((u) => <option key={u}>{u}</option>)}
          </select>
          <span className="text-xs text-black/50">= {toBytes(value, unit).toLocaleString()} bytes</span>
          <button onClick={() => save.mutate({ bigFile: { value, unit } })}
            className="ml-auto lfb-btn lfb-btn-primary">Save</button>
        </div>
      </Section>

      <Section
        title="Scanner roots"
        subtitle="Top-level directories the scan walks to discover repos (one per line)."
      >
        <textarea value={roots} onChange={(e) => setRoots(e.target.value)} rows={4}
          className="lfb-input w-full px-2 py-1.5 font-mono text-xs" />
        <button onClick={() => save.mutate({ scannerRoots: roots.split("\n").map((s) => s.trim()).filter(Boolean) })}
          className="mt-2 lfb-btn lfb-btn-primary">Save roots</button>
      </Section>

      <Section
        title="My forge accounts"
        subtitle="Your own GitHub / GitLab / Bitbucket accounts. A repo whose remote is owned by one of these is treated as Personal — so your own repos aren't mislabeled as a company. One per line: “github.com/yourname” pins the host, or a bare “yourname” matches any forge."
      >
        <textarea value={personalAccts} onChange={(e) => setPersonalAccts(e.target.value)} rows={4}
          placeholder={"github.com/BryanStarbuck\nmyusername"}
          className="lfb-input w-full px-2 py-1.5 font-mono text-xs" />
        <button onClick={() => save.mutate({ personalAccounts: parsePersonalAccounts(personalAccts) })}
          className="mt-2 lfb-btn lfb-btn-primary">Save accounts</button>
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
            className="ml-auto lfb-btn lfb-btn-primary">Save</button>
        </div>
        <p className="mt-2 text-xs text-black/50">
          Tunes background compression, fingerprinting & batch transcription (the mass-compute budget).
          Pinning and scans always keep 2 cores free and aren't affected.
        </p>
      </Section>

      <Section
        title="Git auto-commit"
        subtitle="Whether Large File Bridge may commit and push tracking text from this computer."
      >
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={data.gitBackbone.autoCommit}
            onChange={(e) => save.mutate({ gitBackbone: { autoCommit: e.target.checked } })}
            className="mt-0.5"
          />
          <span className="text-sm text-black/70">
            Automatically commit and push from this computer
            <span className="mt-1 block text-xs text-black/50">
              When off, this computer becomes read-only: it still fetches your other computers' changes
              (fast-forward only), but Large File Bridge never creates a commit or pushes anything from here.
            </span>
          </span>
        </label>
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
            {!ipfsOk
              ? "Unreachable"
              : ipfsPendingRestart
                ? "Restart needed"
                : data.ipfs.compliant
                  ? "Serving only your content"
                  : "Needs a fix"}
          </span>
        }
      >
        <p className="text-sm text-black/70">
          {!ipfsOk
            ? "The IPFS engine isn't answering. Start it from the IPFS page so your files can move."
            : ipfsPendingRestart
              ? "Your only-your-content settings are saved, but IPFS only reads them when it starts — until it restarts, this computer can still relay other people's traffic. Restart it from the IPFS page."
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

      <PowerToolsSection />
    </div>
  );
}

// ── Power tools (debug.mdx §2.1) — LAST section on the page, on purpose ──────────────────────────────
// This is a diagnostics surface, not a preference: nothing above it should be pushed down by it. The
// resolved destination path is shown BEFORE the click, because this file gets committed and pushed and a
// surprise write into a git repo is never acceptable. With no personal storage repo connected the button
// is disabled with the reason inline — there is deliberately NO fallback location (§3), since a debug.yaml
// that cannot reach the user's other computers fails at the one job it has.
function PowerToolsSection() {
  const qc = useQueryClient();
  const { data: target } = useQuery({ queryKey: ["debugTarget"], queryFn: api.debugExportTarget });
  const run = useMutation({
    mutationFn: () => api.debugExport({ scope: "computer", invokedFrom: "settings" }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["debugTarget"] });
      // Never a silent no-op (pin_process.mdx §6): name what and where, and say zero when zero.
      toast.success(
        `Debug information exported — ${r.files} entries across ${r.units} repos → ${r.paths.length} destination${r.paths.length === 1 ? "" : "s"} (${r.path})`,
      );
      if (r.errors.length) toast.warning(`${r.errors.length} repo(s) could not be read; see the errors: block in the file`);
    },
    onError: (e: Error) => { clientLog.error("Settings.debugExport", e); toast.error(e.message); },
  });

  return (
    <Section
      title="Power tools"
      subtitle="Diagnostics for when files aren't syncing between your computers."
      collapsible
      defaultOpen={false}
    >
      <p className="text-sm text-black/70">
        <strong>Export debug information</strong> — writes everything Large File Bridge believes about this
        computer's files to a YAML file in every company sync repo you're connected to and in your personal
        repo, so it reaches whoever needs to compare it against your other computers.
      </p>
      {target?.available ? (
        <div className="mt-2 space-y-0.5">
          {target.paths.map((p) => (
            <p key={p} className="break-all font-mono text-xs text-black/50">
              → {p}
            </p>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--lfb-bad)]">
          {target?.reason ?? "Checking…"}{" "}
          <Link to="/storages/$storageId" params={{ storageId: "personal" }} className="text-[var(--lfb-primary)]">
            Set up personal storage →
          </Link>
        </p>
      )}
      {target?.lastExportAt && (
        <p className="mt-1 text-xs text-black/50">Last exported: {new Date(target.lastExportAt).toLocaleString()}</p>
      )}
      <button
        onClick={() => run.mutate()}
        disabled={!target?.available || run.isPending}
        className="mt-3 lfb-btn lfb-btn-primary"
      >
        {run.isPending ? "Exporting…" : "Export debug information"}
      </button>
    </Section>
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
          className="lfb-input px-2 py-1"
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
          className="lfb-input w-64 px-2 py-1 font-mono text-xs"
        />
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="lfb-input w-40 px-2 py-1 font-mono text-xs"
          title="Model id"
        />
        <button
          onClick={() => { onSave({ ...(key ? { apiKey: key } : {}), model }); setKey(""); }}
          className="lfb-btn lfb-btn-primary lfb-btn-sm"
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
  // Only the tools we genuinely cannot work without are worth nagging about. The image encoders now run
  // in-process, so oxipng / cwebp / cjpeg / jpegoptim being absent changes nothing — listing them as
  // "not installed" sent people to install things that were never used.
  const REQUIRED: Record<string, string> = {
    ffmpeg: "video compression",
    ffprobe: "reading video details",
    magick: "a few image probes",
  };
  const missing = tools ? Object.keys(REQUIRED).filter((k) => !(tools as unknown as Record<string, boolean>)[k]) : [];

  return (
    <Section title="Compression" subtitle="Per-media codec preferences. Resolution — including colour resolution — is always preserved, and a lossless original is never turned into a lossy copy unless you ask.">
      {(["images", "video"] as const).map((m) => (
        <MediaPrefRow key={m} media={m} prefs={s[m]} onSave={(patch) => save.mutate({ [m]: { ...s[m], ...patch } })} />
      ))}
      <SizeFloorRow settings={s} onSave={(patch) => save.mutate(patch)} />
      <p className="mt-2 text-xs text-black/50">Audio compression is disabled for now (planned later).</p>
      {tools && missing.length > 0 && (
        <p className="mt-1 text-xs text-amber-700">
          Not installed: {missing.map((k) => `${k} (${REQUIRED[k]})`).join(", ")} — <code>brew install ffmpeg imagemagick</code>
        </p>
      )}
    </Section>
  );
}

/**
 * The size-gain floors (compression.mdx §2.1 R3). Large File Bridge only replaces a file when the new one
 * is meaningfully smaller — below the floor it keeps the original and says so. Three floors, because how
 * big a win is "worth it" depends on what is being given up.
 */
function SizeFloorRow({ settings, onSave }: { settings: CompressionSettings; onSave: (patch: Partial<CompressionSettings>) => void }) {
  const pct = (n: number) => Math.round(n * 100);
  const Field = ({ label, value, onChange, hint }: { label: string; value: number; onChange: (n: number) => void; hint: string }) => (
    <label className="flex items-center gap-1.5" title={hint}>
      {label}
      <input
        type="number" min={0} max={95} step={1} value={pct(value)}
        className="lfb-input w-16 px-1 py-0.5"
        onChange={(e) => onChange(Math.max(0, Math.min(95, Number(e.target.value))) / 100)}
      />
      %
    </label>
  );
  return (
    <div className="mb-3 rounded-md border border-[var(--lfb-border)] p-3">
      <div className="mb-1 text-sm font-medium">Only replace a file when it actually gets smaller</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Field
          label="Normal compress" value={settings.minSizeGain}
          onChange={(n) => onSave({ minSizeGain: n })}
          hint="A re-encode that spends quality must save at least this much, or the original is kept."
        />
        <Field
          label="Lossless" value={settings.minSizeGainLossless}
          onChange={(n) => onSave({ minSizeGainLossless: n })}
          hint="A lossless re-pack gives up no quality at all, so a smaller win is still worth taking."
        />
        <Field
          label="Lossless → lossy" value={settings.minSizeGainLosslessToLossy}
          onChange={(n) => onSave({ minSizeGainLosslessToLossy: n })}
          hint="Trading a lossless original for a lossy copy is the one destructive transform — it needs a large win to be worth it."
        />
      </div>
      <p className="mt-1 text-xs text-black/50">
        Below the floor, Large File Bridge keeps your original and records why, so the same file is not re-examined on every run.
      </p>
    </div>
  );
}

// Recognized extensions per media type (mirrors @lfb/shared media.ts IMAGE_EXT / VIDEO_EXT). Each row is a
// per-extension IN-SCOPE checkbox (images.mdx §2.2); an unchecked box adds the ext to skipExts (opt-OUT).
// `convertLabel` is the "→ JPEG" / "→ H.264" hint shown when convert_types is ON.
const IMAGE_SCOPE_EXTS = [".heic", ".heif", ".avif", ".png", ".bmp", ".tiff", ".gif", ".jpg", ".jpeg", ".webp"];
const VIDEO_SCOPE_EXTS = [".mov", ".mp4", ".avi", ".mkv", ".webm", ".m4v", ".mpg", ".wmv", ".flv"];
function convertLabel(media: "images" | "video", ext: string): string {
  if (media === "video") return ext === ".mp4" ? "re-encode" : "→ H.264";
  // Images: what actually happens now. A lossless source keeps a LOSSLESS target (PNG), an already-lossy
  // one is re-encoded in place, and only HEIC/HEIF/AVIF become JPEG — as a compatibility conversion.
  if (ext === ".heic" || ext === ".heif" || ext === ".avif") return "→ JPEG";
  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") return "re-encode";
  return "→ PNG (lossless)";
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
          <select className="lfb-input px-1 py-0.5" value={prefs.quality} onChange={(e) => onSave({ quality: e.target.value as CompressQuality })}>
            {QUALITIES.map((q) => <option key={q} value={q}>{q}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5" title="When on, a compress may change the format to a better or more compatible target (HEIC → JPEG, BMP/TIFF → PNG). Off = format-preserving, so no file is ever renamed.">
          <input type="checkbox" checked={prefs.convertTypes} onChange={(e) => onSave({ convertTypes: e.target.checked })} /> Convert file types
        </label>
      </div>
      {media === "images" && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <label
            className="flex items-center gap-1.5"
            title="OFF by default, and it is the most important setting here. PNG, BMP, TIFF and GIF are LOSSLESS — every pixel is exactly as it was saved. Turning this on lets a compress replace one with a JPEG, which throws detail away permanently. It is worst on screenshots: coloured text and thin annotation lines smear. When on, the conversion still has to save at least the 'Lossless → lossy' percentage below, and your original still goes to the trash rather than being deleted."
          >
            <input
              type="checkbox"
              checked={prefs.allowLosslessToLossy === true}
              onChange={(e) => onSave({ allowLosslessToLossy: e.target.checked })}
            />
            Allow lossless images to become lossy
            {prefs.allowLosslessToLossy === true && <span className="ml-1 text-xs text-amber-700">— your PNGs can be replaced by JPEGs</span>}
          </label>
          <label className="flex items-center gap-1.5" title="Try an exact 256-colour palette for images that only use that many colours — common for screenshots. It is checked pixel-by-pixel before it is used, so it can never change the image.">
            <input type="checkbox" checked={prefs.pngPalette !== false} onChange={(e) => onSave({ pngPalette: e.target.checked })} /> Palette PNGs when exact
          </label>
          <label className="flex items-center gap-1.5" title="Refuse any output whose COLOUR resolution is lower than the original's. Colour is stored separately from brightness, and halving it is a resolution reduction that a width/height check cannot see.">
            <input type="checkbox" checked={prefs.guardChroma !== false} onChange={(e) => onSave({ guardChroma: e.target.checked })} /> Guard colour resolution
          </label>
        </div>
      )}
      {media === "video" && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <label className="flex items-center gap-1.5" title="Keep a video's colour detail when it is finer than the usual 4:2:0, instead of silently reducing it. Turned off only for a compatibility convert, where a widely-playable file is the point.">
            <input type="checkbox" checked={prefs.preserveChroma !== false} onChange={(e) => onSave({ preserveChroma: e.target.checked })} /> Preserve colour detail
          </label>
          <label className="flex items-center gap-1.5" title="How hard the encoder searches. Slower presets produce smaller files at the same quality.">
            Encoder effort
            <select
              className="lfb-input px-1 py-0.5"
              value={prefs.preset ?? "slow"}
              onChange={(e) => onSave({ preset: e.target.value })}
            >
              {["veryfast", "faster", "fast", "medium", "slow", "slower"].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-1.5">
          Prefer
          <input className="lfb-input w-48 px-1 py-0.5" value={prefer}
            onChange={(e) => setPrefer(e.target.value)} onBlur={() => onSave({ prefer: parse(prefer) })}
            title="Ordered target codecs; first allowed + available wins" />
        </label>
        <label className="flex items-center gap-1.5">
          Deny
          <input className="lfb-input w-40 px-1 py-0.5" value={deny}
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
