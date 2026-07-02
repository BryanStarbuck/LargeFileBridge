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
