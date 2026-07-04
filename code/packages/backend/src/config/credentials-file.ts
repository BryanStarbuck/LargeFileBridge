// Google OAuth client id/secret from an out-of-repo file; env wins (storage.mdx §10).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

export function loadGoogleCreds(): GoogleCreds {
  // env wins
  let clientId = process.env.GOOGLE_CLIENT_ID || "";
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  if (clientId && clientSecret) return { clientId, clientSecret };

  try {
    const raw = fs.readFileSync(credsFilePath(), "utf8");
    const { data, repaired } = parseCredsJson(raw);
    if (repaired) {
      log.warn(
        "auth",
        `Google creds at ${credsFilePath()} contained invalid invisible whitespace (e.g. non-breaking ` +
          `spaces) — parsed after normalizing. Re-save the file with plain ASCII spaces to silence this.`,
      );
    }
    const json = data as {
      large_files_bridge?: { google?: { clientId?: string; clientSecret?: string } };
      google?: { clientId?: string; clientSecret?: string };
    };
    const g = json.large_files_bridge?.google ?? json.google ?? {};
    clientId = clientId || g.clientId || "";
    clientSecret = clientSecret || g.clientSecret || "";
  } catch (e) {
    // Absence is expected in local dev — not an error. But a file that EXISTS yet fails to read or
    // parse (bad JSON / permissions) is a real misconfiguration the user should be told about.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("auth", `Failed to read/parse Google creds at ${credsFilePath()}: ${(e as Error).message}`);
    }
  }
  return { clientId, clientSecret };
}

export function hasGoogleCreds(): boolean {
  const c = loadGoogleCreds();
  const ok = Boolean(c.clientId && c.clientSecret);
  if (!ok) log.info("auth", "Google OAuth credentials not configured (sign-in disabled).");
  return ok;
}
