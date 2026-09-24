// Reading the local API key (pm/mcp.mdx §6, apis.mdx §3).
//
// The key lives in ~/.credentials/large_files_bridge.json under large_files_bridge.api.secret_key. The WEB
// APP (backend) creates it — at boot, or from Settings → Security → Local API key. This server only READS
// it, and re-reads it on every call so a rotation takes effect without restarting Claude Code.
//
// It refuses a file other users can read (mode & 077): a key anyone on the machine can read is not a
// secret, and quietly using it would teach nobody to fix it. The key is never logged or returned — only a
// short fingerprint of it.
import crypto from "node:crypto";
import fs from "node:fs";
import { credsFilePath } from "./config.js";

export class CredentialError extends Error {
  constructor(
    readonly code: "credentials_missing" | "credentials_mode" | "credentials_invalid",
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

export function readApiKey(): string {
  const p = credsFilePath();
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new CredentialError(
      "credentials_missing",
      `No Large File Bridge credentials file at ${p}.`,
      "Start the web app once (just run in ~/BGit/Bryan_git/LargeFileBridge) — it creates the key — or use Settings → Security → Local API key → Create.",
    );
  }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new CredentialError(
      "credentials_mode",
      `${p} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); refusing to use the key in it.`,
      `Run: chmod 600 ${p}`,
    );
  }
  let doc: { large_files_bridge?: { api?: { secret_key?: unknown } } };
  try {
    const raw = fs.readFileSync(p, "utf8").replace(/[​‌‍⁠﻿]/g, "");
    doc = JSON.parse(raw);
  } catch (e) {
    throw new CredentialError("credentials_invalid", `${p} is not valid JSON (${(e as Error).message}).`, "Fix the JSON by hand; nothing will overwrite it.");
  }
  const key = doc.large_files_bridge?.api?.secret_key;
  if (typeof key !== "string" || key.length < 32) {
    throw new CredentialError(
      "credentials_missing",
      `${p} has no large_files_bridge.api.secret_key yet.`,
      "Open the web app → Settings → Security → Local API key → Create (or restart the backend, which creates it).",
    );
  }
  return key;
}

/** Safe to show: tells two keys apart, reveals nothing. */
export function keyFingerprint(key: string): string {
  return `sha256:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}
