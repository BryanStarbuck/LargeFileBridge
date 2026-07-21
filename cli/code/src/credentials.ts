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

function readDoc(p: string): CredsShape {
  try {
    const raw = fs.readFileSync(p, "utf8");
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
  } catch {
    return {};
  }
}

export function loadApiSecret(): string | null {
  const key = readDoc(credsFilePath()).large_files_bridge?.api?.secret_key;
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
