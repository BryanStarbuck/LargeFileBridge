// The SHARED Google / Gemini API-key file (ai_description.mdx §3.2). This is the SAME file the
// ~/BGit/all/tools Gemini / "nano banana" tools read — `~/.config/GoogleCloud/apikey.yaml` — a small
// YAML file with two fields:
//   apiKey     — the standard AI Studio Gemini key (used for vision / description)
//   4k_apiKey  — a separate key for 4K image generation (Imagen); used here only as a FALLBACK
//
// LFBridge reads this file as a THIRD Gemini key source, AFTER the app config (config.yaml) and the
// well-known env vars, so a machine already set up for those tools "just works" for AI description
// without re-entering the key anywhere. We prefer `apiKey` then `4k_apiKey`, matching the tools'
// vision path (~/BGit/all/tools/Img_to_Description/img_describe.js). The key VALUE never leaves this
// process except as the (user-initiated) Gemini upload — it is never written back into the repo or
// returned to the frontend; the setup UI only ever sees the path + a placeholder schema.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { log } from "../shared/logging.js";

export const GOOGLE_APIKEY_FILENAME = "apikey.yaml";

// The fields the shared file may hold, in the priority order we read them for DESCRIPTION (vision):
// the plain `apiKey` first, the 4K/Imagen key `4k_apiKey` as a fallback.
export const GOOGLE_APIKEY_FIELDS = ["apiKey", "4k_apiKey"] as const;

// A placeholder-only template the setup UI shows. The real file lives OUT of any repo and holds a
// secret — we only ever surface this placeholder, never the on-disk value.
export const GOOGLE_APIKEY_SCHEMA_EXAMPLE = `# Google Cloud / Gemini API key(s).
# Get a key at https://aistudio.google.com/app/apikey
apiKey: "YOUR_GEMINI_API_KEY"

# Optional: a separate key for 4K image generation (Google Imagen). Used only as a
# fallback for AI descriptions when apiKey above is absent.
4k_apiKey: "YOUR_GEMINI_API_KEY"
`;

/** The path LFBridge reads the shared Google/Gemini key from. Overridable for tests / non-default
 *  layouts via LFB_GOOGLE_APIKEY_FILE. */
export function googleApiKeyFilePath(): string {
  return (
    process.env.LFB_GOOGLE_APIKEY_FILE ||
    path.join(os.homedir(), ".config", "GoogleCloud", GOOGLE_APIKEY_FILENAME)
  );
}

// A value counts as a real key only when it is a non-empty string that is not the shipped placeholder.
// The tools auto-create the file with empty / "YOUR_..." values; those must NOT read as configured.
function looksReal(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  if (/^YOUR_/i.test(s)) return false;
  return true;
}

/**
 * The Gemini API key from the shared GoogleCloud key file — `apiKey`, else `4k_apiKey` — or null when
 * the file is absent, unreadable, invalid YAML, or holds only placeholders. NEVER throws: a missing
 * file is the normal case (this is one of several key sources), and a broken file must not wedge the
 * describe feature — it just means "no key from here."
 */
export function loadGoogleApiKey(): string | null {
  const p = googleApiKeyFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    // Absence is expected — only a file that EXISTS yet fails to read is worth a warning.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("describe", `Failed to read Google API-key file at ${p}: ${(e as Error).message}`);
    }
    return null;
  }
  let doc: Record<string, unknown>;
  try {
    doc = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
  } catch (e) {
    log.warn("describe", `Google API-key file at ${p} is not valid YAML: ${(e as Error).message}`);
    return null;
  }
  for (const field of GOOGLE_APIKEY_FIELDS) {
    if (looksReal(doc[field])) return (doc[field] as string).trim();
  }
  return null;
}

/** True when the shared Google/Gemini key file yields a usable key on this machine. */
export function hasGoogleApiKeyFile(): boolean {
  return !!loadGoogleApiKey();
}

/** Setup guidance for the instructions page (ai_credentials.mdx): the exact path/filename/dir, the
 *  fields, whether it exists / is configured, and a PLACEHOLDER schema — never the secret value. */
export function googleApiKeyFileInfo(): {
  path: string;
  filename: string;
  directory: string;
  fields: string[];
  exists: boolean;
  configured: boolean;
  schemaExample: string;
} {
  const p = googleApiKeyFilePath();
  let exists = false;
  try {
    exists = fs.statSync(p).isFile();
  } catch {
    exists = false;
  }
  return {
    path: p,
    filename: path.basename(p),
    directory: path.dirname(p),
    fields: [...GOOGLE_APIKEY_FIELDS],
    exists,
    configured: !!loadGoogleApiKey(),
    schemaExample: GOOGLE_APIKEY_SCHEMA_EXAMPLE,
  };
}
