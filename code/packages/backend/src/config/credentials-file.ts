// Google OAuth client id/secret from an out-of-repo file; env wins (storage.mdx §10).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "../shared/logging.js";
import { isFileAt } from "../shared/fs-probe.js";

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
  const exists = isFileAt(p); // shared/fs-probe — non-throwing
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
// Last presence value hasGoogleCreds() logged, so the line is emitted on transitions only (see below).
let lastCredsPresence: boolean | null = null;

function hashOf(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** Test-only: drop the cached file read + dedupe state so a test can simulate a fresh process. */
export function _resetCredsCacheForTests(): void {
  fileCredsCache = null;
  lastWarnedRepairedHash = null;
  lastWarnedFailureHash = null;
  lastCredsPresence = null;
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
  // Log only on a STATE CHANGE. identify.ts consults this on (near) every request and the auth
  // middleware now re-checks it on every /api/v1 hit, so an unconditional log.info here wrote the
  // same "not configured" line hundreds of times and buried the one moment that matters — the
  // transition. Both directions are logged: creds appearing is the event that re-mounts the
  // Frontend API (auth-frontend.ts credsFingerprint), creds disappearing un-mounts it.
  if (ok !== lastCredsPresence) {
    lastCredsPresence = ok;
    log.info(
      "auth",
      ok
        ? "Google OAuth credentials found (sign-in enabled)."
        : "Google OAuth credentials not configured (sign-in disabled).",
    );
  }
  return ok;
}

/**
 * Fingerprint of the CURRENT Google creds — a sha256 of the id/secret pair, never the values
 * themselves, so nothing that holds this is holding a second plaintext copy of the secret. The auth
 * middleware compares this against the fingerprint it was BUILT with to decide whether it must be
 * rebuilt (auth-frontend.ts). Empty creds hash to a stable value, so absent → present → changed →
 * absent are all distinguishable transitions.
 */
export function googleCredsFingerprint(): string {
  const c = loadGoogleCreds();
  return hashOf(`${c.clientId}\u0000${c.clientSecret}`);
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
 *
 * REFUSES to write when the file EXISTS but cannot be parsed. The old code treated "unparseable" like
 * "absent" and wrote a fresh document holding only the api block — silently destroying the Google OAuth
 * credentials in a file that a single stray comma had made invalid. A broken secrets file is a human's to
 * fix; we say exactly where, and never overwrite it.
 */
export function ensureApiSecret(): string {
  const existing = loadApiSecret();
  if (existing) {
    tightenCredsMode();
    return existing;
  }
  return writeApiSecret("created");
}

/**
 * Replace the shared API secret with a new one (Settings → Security → "Rotate local API key", apis.mdx §3.4).
 * Every CLI / MCP process picks the new key up on its next call (both read the file per call), and the
 * old key stops working at once — no grace window, on purpose: rotation is what you do after a leak.
 */
export function rotateApiSecret(): string {
  return writeApiSecret("rotated");
}

function writeApiSecret(verb: "created" | "rotated"): string {
  const p = credsFilePath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let doc: ApiSecretShape = {};
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (raw !== null && raw.trim() !== "") {
    const { data } = parseCredsJson(raw); // throws on invalid JSON — the caller logs it; the file is untouched
    if (data && typeof data === "object") doc = data as ApiSecretShape;
    else throw new Error(`${p} is not a JSON object — fix it by hand; refusing to overwrite it`);
  }
  const secret = crypto.randomBytes(32).toString("hex");
  doc.large_files_bridge = {
    ...(doc.large_files_bridge ?? {}),
    api: { secret_key: secret, created: new Date().toISOString() },
  };
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
  tightenCredsMode();
  log.info("auth", `${verb === "created" ? "Created" : "Rotated"} the local API secret (CLI + MCP) at ${p}.`);
  // Invalidate the mtime-keyed Google-creds cache — the file just changed under it.
  fileCredsCache = null;
  return secret;
}

/** The credentials file must be 0600 (owner-only). Self-heal a loose mode — we own the file — and say so. */
function tightenCredsMode(): void {
  if (process.platform === "win32") return;
  const p = credsFilePath();
  try {
    const mode = fs.statSync(p).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      fs.chmodSync(p, 0o600);
      log.warn("auth", `${p} was readable by other users (mode ${mode.toString(8)}) — tightened to 600`);
    }
  } catch (e) {
    log.warn("auth", `could not check/tighten the mode of ${p}: ${(e as Error).message}`);
  }
}

/** A safe-to-show description of the secret: never the key itself (apis.mdx §3.5). */
export function apiSecretStatus(): { path: string; exists: boolean; created: string | null; fingerprint: string | null; mode: string | null } {
  const p = credsFilePath();
  let created: string | null = null;
  let mode: string | null = null;
  try {
    const { data } = parseCredsJson(fs.readFileSync(p, "utf8"));
    created = (data as ApiSecretShape).large_files_bridge?.api?.created ?? null;
    mode = (fs.statSync(p).mode & 0o777).toString(8);
  } catch {
    /* absent or unreadable */
  }
  const key = loadApiSecret();
  return {
    path: p,
    exists: key !== null,
    created,
    // First 4 hex of the key's SHA-256 + length — enough to tell two keys apart, useless to an attacker.
    fingerprint: key ? `sha256:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)}` : null,
    mode,
  };
}
