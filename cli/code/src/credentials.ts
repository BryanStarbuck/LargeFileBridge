// Shared API secret bootstrap — the CLI side of cli.mdx §3. Mirrors the backend's
// ensureApiSecret() (code/packages/backend/src/config/credentials-file.ts): whichever process runs
// first creates the key; the other reads it. MERGES into the existing JSON (the file also carries
// the app's Google OAuth block) — never clobbers other keys. 0600 file / 0700 dir, atomic write.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function credsFilePath(): string {
  return (
    process.env.LFB_CREDENTIALS_FILE ||
    path.join(os.homedir(), ".credentials", "large_files_bridge.json")
  );
}

interface CredsShape {
  large_files_bridge?: { api?: { secret_key?: string; created?: string } } & Record<string, unknown>;
}

/**
 * Parse the credentials file. `{}` ONLY when the file does not exist. A file that exists but will not parse
 * THROWS: the old behaviour (treat it like an empty file) let ensureApiSecret() write a fresh document over
 * it and silently delete the Google OAuth block beside the key. A broken secrets file is a human's to fix.
 */
function readDoc(p: string): CredsShape {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read ${p}: ${(e as Error).message}`);
  }
  if (raw.trim() === "") return {};
  try {
    // Tolerate the invisible-whitespace corruption a hand-edited secrets file picks up (same repair
    // the backend applies): strip zero-width chars, normalize NBSP-like spaces, then parse.
    try {
      return JSON.parse(raw) as CredsShape;
    } catch {
      const cleaned = raw
        .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "")
        .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
      return JSON.parse(cleaned) as CredsShape;
    }
  } catch (e) {
    throw new Error(`${p} is not valid JSON (${(e as Error).message}) — fix it by hand; Large File Bridge will not overwrite it`);
  }
}

export function loadApiSecret(): string | null {
  let doc: CredsShape;
  try {
    doc = readDoc(credsFilePath());
  } catch {
    return null; // ensureApiSecret() re-reads and surfaces the real error instead of overwriting
  }
  const key = doc.large_files_bridge?.api?.secret_key;
  return typeof key === "string" && key.length >= 32 ? key : null;
}

/** Load the secret, creating it (CSPRNG, 32 bytes → 64 hex chars) when missing (cli.mdx §3.1). */
export function ensureApiSecret(): string {
  const existing = loadApiSecret();
  if (existing) return existing;
  const p = credsFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const doc = readDoc(p);
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
    /* rename preserved the tmp file's 0600 */
  }
  process.stderr.write(`Large File Bridge created its local API secret at ${p}.\n`);
  return secret;
}
