// Setup guidance shown when the Google OAuth credentials file can't be found on this computer
// (storage.mdx §10). Displays the exact full path, the JSON filename to create, and the schema to
// fill in. The secret VALUES never travel from the server — this only shows a placeholder schema.
import { useState } from "react";
import { Copy, Check, KeyRound } from "lucide-react";
import type { CredentialsFileInfo } from "@lfb/shared";
import { clientLog } from "../lib/clientLog.js";

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
          // Clipboard blocked (permissions / insecure context) — non-fatal; the value is visible
          // to copy by hand. Log at warn so the silent failure still leaves a fault trail.
          clientLog.warn("CredentialsSetupCard.copy", e);
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

export function CredentialsSetupCard({
  info,
  redirectUri,
  allowedDomains,
  devAuth = false,
}: {
  info: CredentialsFileInfo;
  redirectUri?: string;
  allowedDomains?: string[];
  devAuth?: boolean;
}) {
  const schema = JSON.stringify(info.schemaExample, null, 2);
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-5 text-left">
      <div className="flex items-center gap-2 text-amber-800">
        <KeyRound className="h-5 w-5" />
        <h2 className="font-semibold">Google sign-in isn’t configured on this computer</h2>
      </div>
      <p className="mt-2 text-sm text-black/70">
        Large File Bridge reads your Google OAuth credentials from a JSON file on this machine. It
        wasn’t found here. Create the file below, then reload this page.
      </p>

      {/* Full path + filename */}
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-black/50">
            Create this file
          </span>
          <CopyButton text={info.path} label="file path" />
        </div>
        <code className="block break-all rounded-md border border-[var(--lfb-border)] bg-white px-3 py-2 font-mono text-sm">
          {info.path}
        </code>
        <p className="mt-1 text-xs text-black/50">
          Filename must be exactly <b className="font-mono">{info.filename}</b>, inside{" "}
          <span className="font-mono">{info.directory}</span>.
          {info.exists && " (A file exists at this path but is missing valid credentials.)"}
        </p>
      </div>

      {/* Schema to fill in */}
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-black/50">
            With this exact JSON shape
          </span>
          <CopyButton text={schema} label="schema" />
        </div>
        <pre className="overflow-x-auto rounded-md border border-[var(--lfb-border)] bg-white px-3 py-2 font-mono text-xs leading-relaxed">
          {schema}
        </pre>
        <p className="mt-1 text-xs text-black/50">
          Replace the placeholder values with your Google OAuth client ID and secret. This file holds
          secrets — keep it out of any git repository.
        </p>
      </div>

      {/* Exact redirect URI to register on the Google Cloud OAuth client (webapp.mdx §3.2 item 3) —
          built from the API port 8787, not the web port. Must match VERBATIM or Google rejects it. */}
      {redirectUri && (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-black/50">
              Register this redirect URI on the OAuth client
            </span>
            <CopyButton text={redirectUri} label="redirect URI" />
          </div>
          <code className="block break-all rounded-md border border-[var(--lfb-border)] bg-white px-3 py-2 font-mono text-sm">
            {redirectUri}
          </code>
          <p className="mt-1 text-xs text-black/50">
            Add it verbatim under the client’s “Authorized redirect URIs” — it uses the API port (8787),
            not the web app port.
          </p>
        </div>
      )}

      {/* Restart nudge (webapp.mdx §3.2 item 4): credentials are read at boot, so a restart is required. */}
      <p className="mt-4 text-sm text-black/70">
        Then <b>restart the backend</b> and reload this page.
      </p>

      {allowedDomains && allowedDomains.length > 0 && (
        <p className="mt-2 text-xs text-black/50">
          Sign-in will accept a Google account on{" "}
          <span className="font-mono">{allowedDomains.join(", ")}</span> that is also on the allow-list.
        </p>
      )}

      <p className="mt-4 text-xs text-black/50">
        Alternatively, set <span className="font-mono">GOOGLE_CLIENT_ID</span> and{" "}
        <span className="font-mono">GOOGLE_CLIENT_SECRET</span> in the environment (they take
        precedence over the file), or — on localhost only — run with{" "}
        <span className="font-mono">LFB_DEV_AUTH=true</span> to bypass sign-in for offline development.
        {devAuth && " Local dev mode is active, so the app is usable without sign-in for now."}
      </p>
    </div>
  );
}
