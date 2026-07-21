// Google OAuth client id/secret from an out-of-repo file; env wins (storage.mdx §10).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "../shared/logging.js";

export interface GoogleCreds {
  clientId: string;
  clientSecret: string;
}

// The one credentials file LFB reads Google OAuth from (storage.mdx §10). Its contents are secrets
// and MUST live out-of-repo, under the user's ~/.credentials/. We never write the secret VALUES
// anywhere in the codebase — only this expected filename and a placeholder schema for the setup UI.
export const CREDS_FILENAME = "large_files_bridge.json";
export const CREDS_SCHEMA_EXAMPLE = {
  large_files_bridge: {
    google: {
      clientId: "YOUR_GOOGLE_OAUTH_CLIENT_ID",
      clientSecret: "YOUR_GOOGLE_OAUTH_CLIENT_SECRET",
    },
  },
} as const;

export function credsFilePath(): string {
  return (
    process.env.LFB_CREDENTIALS_FILE ||
    path.join(os.homedir(), ".credentials", CREDS_FILENAME)
  );
}

// Unicode whitespace that looks identical to an ASCII space in an editor but is NOT valid JSON
// whitespace: non-breaking space (U+00A0), the en/em space family (U+2000–U+200A), narrow &
// medium math spaces (U+202F, U+205F) and the ideographic space (U+3000). A single one used as
// indentation makes JSON.parse reject the whole file.
const NBSP_LIKE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
// Zero-width characters (ZWSP, ZWNJ, ZWJ, word joiner) and the byte-order mark — dropped entirely.
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/g;

/**
 * Parse the creds JSON, tolerating the invisible-whitespace corruption a hand-edited or copy-pasted
 * secrets file routinely picks up. We first parse as-is (well-formed files are untouched); only on
 * failure do we normalize BOM / NBSP-like / zero-width characters to plain ASCII and retry. That
 * keeps a stray non-breaking space from silently disabling all sign-in. Returns { repaired } so the
 * caller can note that the on-disk file should be cleaned up.
 */
export function parseCredsJson(raw: string): { data: unknown; repaired: boolean } {
  try {
    return { data: JSON.parse(raw), repaired: false };
  } catch (first) {
    const cleaned = raw.replace(ZERO_WIDTH, "").replace(NBSP_LIKE, " ");
    if (cleaned === raw) throw first; // nothing to repair — surface the original parse error
    return { data: JSON.parse(cleaned), repaired: true };
  }
}

/**
 * Setup guidance for the UI when creds can't be found on this computer. Reports the exact file path,
 * filename, and the schema to create — WITHOUT ever returning the secret values themselves.
 */
export function credentialsFileInfo(): {
  configured: boolean;
  usingEnv: boolean;
  exists: boolean;
  path: string;
  filename: string;
  directory: string;
  schemaExample: typeof CREDS_SCHEMA_EXAMPLE;
} {
  const p = credsFilePath();
  const usingEnv = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  let exists = false;
  try {
    exists = fs.statSync(p).isFile();
  } catch {
    exists = false;
  }
  return {
    configured: hasGoogleCreds(),
    usingEnv,
    exists,
    path: p,
    filename: path.basename(p),
    directory: path.dirname(p),
    schemaExample: CREDS_SCHEMA_EXAMPLE,
  };
}

// loadGoogleCreds() runs on (or near) every request through identify.ts, so re-reading and
// re-JSON.parse'ing the file on each call is both a perf cost and — for a file that is persistently
// unparsable — a way to emit the SAME warning hundreds of times into error.err. We cache the
// file-derived id/secret keyed by the file's (mtimeMs, size); a cache hit skips the read+parse
// entirely. On top of that, the two warn() calls are separately deduped by a hash of the exact raw
// bytes that provoked them, so even if the cache is bypassed (or the mtime granularity is coarser
// than a rapid edit-save-edit cycle) the identical problem is never logged twice in a row.
interface FileDerivedCreds {
  mtimeMs: number;
  size: number;
  clientId: string;
  clientSecret: string;
}
let fileCredsCache: FileDerivedCreds | null = null;
let lastWarnedRepairedHash: string | null = null;
let lastWarnedFailureHash: string | null = null;

function hashOf(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** Test-only: drop the cached file read + dedupe state so a test can simulate a fresh process. */
export function _resetCredsCacheForTests(): void {
  fileCredsCache = null;
  lastWarnedRepairedHash = null;
  lastWarnedFailureHash = null;
}

export function loadGoogleCreds(): GoogleCreds {
  // env wins
  let clientId = process.env.GOOGLE_CLIENT_ID || "";
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  if (clientId && clientSecret) return { clientId, clientSecret };

  const p = credsFilePath();
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(p);
  } catch {
    stat = null;
  }

  // File absent: nothing to read/parse/log (expected in local dev). Drop any stale cache so a file
  // that reappears later gets a fresh read instead of serving a previous mtime's cached result.
  if (!stat) {
    fileCredsCache = null;
    return { clientId, clientSecret };
  }

  if (
    fileCredsCache &&
    fileCredsCache.mtimeMs === stat.mtimeMs &&
    fileCredsCache.size === stat.size
  ) {
    clientId = clientId || fileCredsCache.clientId;
    clientSecret = clientSecret || fileCredsCache.clientSecret;
    return { clientId, clientSecret };
  }

  let fileClientId = "";
  let fileClientSecret = "";
  try {
    const raw = fs.readFileSync(p, "utf8");
    const { data, repaired } = parseCredsJson(raw);
    if (repaired) {
      const h = hashOf(raw);
      if (lastWarnedRepairedHash !== h) {
        lastWarnedRepairedHash = h;
        log.warn(
          "auth",
          `Google creds at ${p} contained invalid invisible whitespace (e.g. non-breaking ` +
            `spaces) — parsed after normalizing. Re-save the file with plain ASCII spaces to silence this.`,
        );
      }
    }
    const json = data as {
      large_files_bridge?: { google?: { clientId?: string; clientSecret?: string } };
      google?: { clientId?: string; clientSecret?: string };
    };
    const g = json.large_files_bridge?.google ?? json.google ?? {};
    fileClientId = g.clientId || "";
    fileClientSecret = g.clientSecret || "";
  } catch (e) {
    // Absence is expected in local dev — not an error. But a file that EXISTS yet fails to read or
    // parse (bad JSON / permissions) is a real misconfiguration the user should be told about. Dedupe
    // by a hash of the failure message + path so an unchanged, persistently-broken file logs once,
    // not on every request.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = (e as Error).message;
      const h = hashOf(`${p}:${message}`);
      if (lastWarnedFailureHash !== h) {
        lastWarnedFailureHash = h;
        log.warn("auth", `Failed to read/parse Google creds at ${p}: ${message}`);
      }
    }
  }

  fileCredsCache = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    clientId: fileClientId,
    clientSecret: fileClientSecret,
  };
  clientId = clientId || fileClientId;
  clientSecret = clientSecret || fileClientSecret;
  return { clientId, clientSecret };
}

export function hasGoogleCreds(): boolean {
  const c = loadGoogleCreds();
  const ok = Boolean(c.clientId && c.clientSecret);
  if (!ok) log.info("auth", "Google OAuth credentials not configured (sign-in disabled).");
  return ok;
}

// ── CLI ↔ web app shared API secret (cli.mdx §3) ─────────────────────────────
// A machine-caller secret both local processes can read because they share the filesystem. It lives
// in the SAME ~/.credentials/large_files_bridge.json as the Google creds, under an `api` block, and
// is AUTO-CREATED by whichever side needs it first (backend boot or a CLI invocation) with a CSPRNG.
// Localhost-only by design: possession of the file proves same-user, same-machine. Never valid for a
// non-loopback caller (enforced at the auth seam, identify.ts).

interface ApiSecretShape {
  large_files_bridge?: { api?: { secret_key?: string; created?: string } } & Record<string, unknown>;
}

/** Read the shared API secret from the credentials file. Null when absent/unreadable. */
export function loadApiSecret(): string | null {
  const p = credsFilePath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const { data } = parseCredsJson(raw);
    const key = (data as ApiSecretShape).large_files_bridge?.api?.secret_key;
    return typeof key === "string" && key.length >= 32 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the shared API secret exists, creating it (crypto.randomBytes(32) → 64 hex chars) when
 * missing. MERGES into the existing JSON — other keys in the file (google creds, unrelated apps'
 * blocks) are never clobbered. Atomic write (temp + rename), file mode 0600, dir mode 0700.
 */
export function ensureApiSecret(): string {
  const existing = loadApiSecret();
  if (existing) return existing;
  const p = credsFilePath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let doc: ApiSecretShape = {};
  try {
    const { data } = parseCredsJson(fs.readFileSync(p, "utf8"));
    if (data && typeof data === "object") doc = data as ApiSecretShape;
  } catch {
    /* absent or unreadable → start fresh (merge target stays {}) */
  }
  const secret = crypto.randomBytes(32).toString("hex");
  doc.large_files_bridge = {
    ...(doc.large_files_bridge ?? {}),
    api: { secret_key: secret, created: new Date().toISOString() },
  };
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best-effort — rename preserved the tmp file's 0600 already */
  }
  log.info("auth", `Created shared API secret for the Large File Bridge CLI at ${p}.`);
  // Invalidate the mtime-keyed Google-creds cache — the file just changed under it.
  fileCredsCache = null;
  return secret;
}
