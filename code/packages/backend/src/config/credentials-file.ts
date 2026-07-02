// Google OAuth client id/secret from an out-of-repo file; env wins (storage.mdx §10).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "../shared/logging.js";

export interface GoogleCreds {
  clientId: string;
  clientSecret: string;
}

function credsFilePath(): string {
  return (
    process.env.LFB_CREDENTIALS_FILE ||
    path.join(os.homedir(), ".credentials", "large_files_bridge.json")
  );
}

export function loadGoogleCreds(): GoogleCreds {
  // env wins
  let clientId = process.env.GOOGLE_CLIENT_ID || "";
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  if (clientId && clientSecret) return { clientId, clientSecret };

  try {
    const raw = fs.readFileSync(credsFilePath(), "utf8");
    const json = JSON.parse(raw) as {
      large_files_bridge?: { google?: { clientId?: string; clientSecret?: string } };
      google?: { clientId?: string; clientSecret?: string };
    };
    const g = json.large_files_bridge?.google ?? json.google ?? {};
    clientId = clientId || g.clientId || "";
    clientSecret = clientSecret || g.clientSecret || "";
  } catch {
    // absence is expected in local dev — not an error
  }
  return { clientId, clientSecret };
}

export function hasGoogleCreds(): boolean {
  const c = loadGoogleCreds();
  const ok = Boolean(c.clientId && c.clientSecret);
  if (!ok) log.info("auth", "Google OAuth credentials not configured (sign-in disabled).");
  return ok;
}
