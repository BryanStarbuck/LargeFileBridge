// The "AI credentials" setup page (ai_credentials.mdx). A full page — opened in a NEW TAB by the
// "Instructions" button of the credentials-missing popup — that tells the user exactly WHERE to put a
// Gemini API key and in WHAT format so AI description works. It shows three sources, in the order
// LargeFileBridge resolves them:
//   1. The shared GoogleCloud/apikey.yaml key file (the SAME file the ~/BGit/all/tools Gemini /
//      nano-banana tools read) — the primary, copy-paste-a-placeholder path this page centers on.
//   2. Settings → Tools (writes the key into the app config.yaml).
//   3. Environment variables (GEMINI_API_KEY / …).
// The raw key value is NEVER shown — only the path and a placeholder schema to fill in.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, KeyRound, CheckCircle2, AlertCircle } from "lucide-react";
import { api } from "@/api/client";
import { clientLog } from "@/lib/clientLog";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (e) {
          clientLog.warn("AiCredentialsPage.copy", e);
        }
      }}
      className="inline-flex items-center gap-1 rounded border border-[var(--lfb-border)] px-2 py-1 text-xs text-black/60 hover:bg-black/5"
      aria-label={`Copy ${label}`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function AiCredentialsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["ai-credentials"], queryFn: () => api.aiCredentials() });

  return (
    <div className="mx-auto max-w-3xl px-2 py-6">
      <div className="flex items-center gap-2 text-black">
        <KeyRound className="h-6 w-6 text-amber-700" />
        <h1 className="text-2xl font-semibold">AI credentials — set up a Gemini key</h1>
      </div>
      <p className="mt-2 text-sm text-black/65">
        Large File Bridge generates a hyper-detailed description of an image or video by sending it to a
        vision model. That needs an API key. <b>Gemini</b> (Google) is the only provider that can describe
        <b> video</b>, so a Gemini key is the one to set. This page shows exactly where the key file goes,
        its format, and what to put inside.
      </p>

      {isLoading && <div className="mt-6 text-sm text-black/50">Loading…</div>}
      {error && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Couldn’t load the credentials details. You can still create the file below at{" "}
          <code className="font-mono">~/.config/GoogleCloud/apikey.yaml</code>.
        </div>
      )}

      {data && (
        <>
          {/* Current status banner */}
          <div
            className={`mt-5 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${
              data.anyAvailable
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            {data.anyAvailable ? <CheckCircle2 className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
            {data.anyAvailable
              ? "A provider key is configured — AI description is ready to use on this computer."
              : "No provider key is configured on this computer yet — follow step 1 below, then reload the viewer."}
          </div>

          {/* Step 1 — the shared key file */}
          <section className="mt-6 rounded-xl border border-[var(--lfb-border)] p-5">
            <h2 className="text-lg font-semibold text-black">1. Create the shared key file (recommended)</h2>
            <p className="mt-1 text-sm text-black/65">
              This is the <b>same file</b> the Gemini / “nano banana” image tools already use, so if you’ve
              set those up the key is shared automatically. Create this file
              {data.file.exists ? " (it already exists — make sure it holds a real key):" : ":"}
            </p>

            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-black/50">Create this file</span>
                <CopyButton text={data.file.path} label="file path" />
              </div>
              <code className="block break-all rounded-md border border-[var(--lfb-border)] bg-slate-50 px-3 py-2 font-mono text-sm">
                {data.file.path}
              </code>
              <p className="mt-1 text-xs text-black/50">
                Filename must be exactly <b className="font-mono">{data.file.filename}</b>, inside{" "}
                <span className="font-mono">{data.file.directory}</span>.{" "}
                {data.file.exists
                  ? data.file.configured
                    ? "This file exists and holds a usable key."
                    : "A file exists here but has no usable key yet — fill in the placeholder below."
                  : "It doesn’t exist yet."}
              </p>
            </div>

            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-black/50">
                  With this exact YAML shape
                </span>
                <CopyButton text={data.file.schemaExample} label="file contents" />
              </div>
              <pre className="overflow-x-auto rounded-md border border-[var(--lfb-border)] bg-slate-50 px-3 py-2 font-mono text-xs leading-relaxed">
                {data.file.schemaExample}
              </pre>
              <p className="mt-1 text-xs text-black/50">
                Replace <b className="font-mono">YOUR_GEMINI_API_KEY</b> with your own key from{" "}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--lfb-primary)] hover:underline"
                >
                  aistudio.google.com/app/apikey
                </a>
                . We read <b className="font-mono">{data.file.fields[0]}</b> first
                {data.file.fields[1] ? (
                  <>
                    , then fall back to <b className="font-mono">{data.file.fields[1]}</b>
                  </>
                ) : null}
                . This file holds a secret — keep it out of any git repository.
              </p>
            </div>
          </section>

          {/* Step 2 — Settings, and Step 3 — env vars */}
          <section className="mt-6 rounded-xl border border-[var(--lfb-border)] p-5">
            <h2 className="text-lg font-semibold text-black">Other ways to provide a key</h2>
            <p className="mt-2 text-sm text-black/65">
              Any one of these is enough — Large File Bridge checks them in this order: the app config
              (Settings → Tools), then environment variables, then the shared key file above.
            </p>
            <ul className="mt-3 space-y-3 text-sm text-black/70">
              <li>
                <b>Settings → Tools</b> — paste a key into the AI provider editor. It’s saved into the app
                config file:
                <code className="mt-1 block break-all rounded border border-[var(--lfb-border)] bg-slate-50 px-2 py-1 font-mono text-xs">
                  {data.appConfigPath}
                </code>
              </li>
              <li>
                <b>Environment variables</b> — export any of these before starting the backend:
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {[...data.envVars.gemini, ...data.envVars.grok, ...data.envVars.openai].map((v) => (
                    <code
                      key={v}
                      className="rounded border border-[var(--lfb-border)] bg-slate-50 px-2 py-0.5 font-mono text-xs"
                    >
                      {v}
                    </code>
                  ))}
                </div>
                <p className="mt-1 text-xs text-black/50">
                  Gemini honors {data.envVars.gemini.join(" / ")}; Grok (images only){" "}
                  {data.envVars.grok.join(" / ")}; OpenAI (images only) {data.envVars.openai.join(" / ")}.
                </p>
              </li>
            </ul>
          </section>

          <p className="mt-4 text-xs text-black/50">
            After creating the file (or setting a key), reload the media viewer and click <b>Generate
            description</b> again. A key added by file or env is read at backend start, so restart the
            backend if it was already running.
          </p>
        </>
      )}
    </div>
  );
}
