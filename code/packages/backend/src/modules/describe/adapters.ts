// AI-description PROVIDER ADAPTERS (ai_description.mdx §5). A small pluggable set of vision models the
// backend can call to describe a local image/video. Which one runs is chosen by (a) an explicit request,
// else (b) the configured default, else (c) the first one that has an API key AND supports the media
// kind. Keys are resolved from the app config (local config.yaml) first, then well-known env vars — so a
// machine that already exports GEMINI_API_KEY / XAI_API_KEY / OPENAI_API_KEY "just works".
//
// IMPORTANT — this is the ONE place LargeFileBridge reaches the network on purpose. Generating a
// description UPLOADS the chosen file's bytes to the selected provider. It is ALWAYS an explicit,
// user-initiated action (a Generate click), never automatic, and it is entirely separate from the
// charter's local-only perceptual-fingerprint feature (which must never phone home).
import fs from "node:fs";
import path from "node:path";
import type { MediaKind, DescribeProvider } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { loadGoogleApiKey, hasGoogleApiKeyFile } from "../../config/google-apikey-file.js";

export type ProviderId = "gemini" | "grok" | "openai";

export interface DescribeInput {
  absPath: string;
  kind: MediaKind; // "image" | "video" (audio is not described here)
  mimeType: string;
  prompt: string;
}
export interface DescribeAdapter {
  id: ProviderId;
  label: string;
  supports: MediaKind[];
  /** The resolved API key (config → env), or null when this provider is not configured on this machine. */
  apiKey(): string | null;
  available(): boolean;
  /** Describe the file. Returns the description text + the exact model id used. Throws on any failure. */
  describe(input: DescribeInput): Promise<{ text: string; model: string }>;
}

// Inline-upload byte cap. Gemini/OpenAI/Grok inline (base64) requests are bounded (~20MB); base64
// inflates by ~4/3, so we cap the raw file well under that and message the user to compress otherwise.
const INLINE_MAX_BYTES = 18 * 1024 * 1024;

function firstEnv(...names: string[]): string | null {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

function readBase64Capped(absPath: string): string {
  const size = fs.statSync(absPath).size;
  if (size > INLINE_MAX_BYTES) {
    throw new Error(
      `file is ${(size / (1024 * 1024)).toFixed(1)}MB — over the ${INLINE_MAX_BYTES / (1024 * 1024)}MB inline limit for AI description. Compress it first, then try again.`,
    );
  }
  return fs.readFileSync(absPath).toString("base64");
}

/** fetch with a hard timeout so a hung provider call can't wedge the request forever. */
async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs = 120_000): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`provider returned non-JSON: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

// ── Gemini (Google) — the only adapter that describes VIDEO as well as images ──────────────────────
const gemini: DescribeAdapter = {
  id: "gemini",
  label: "Google Gemini",
  supports: ["image", "video"],
  apiKey() {
    // Resolution order (ai_description.mdx §3.2): app config → well-known env vars → the SHARED
    // GoogleCloud/apikey.yaml the ~/BGit/all/tools Gemini/nano-banana tools use. That third source
    // means a machine already set up for those tools describes video/images with no extra setup.
    return (
      getAppConfig().ai.gemini.api_key ||
      firstEnv("GEMINI_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_API_KEY") ||
      loadGoogleApiKey()
    );
  },
  available() {
    return !!this.apiKey();
  },
  async describe({ absPath, mimeType, prompt }) {
    const key = this.apiKey();
    if (!key) throw new Error("no Gemini API key");
    const model = getAppConfig().ai.gemini.model || "gemini-2.0-flash";
    const data = readBase64Capped(absPath);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data } }] }],
    };
    const json = (await postJson(url, body, {})) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      promptFeedback?: { blockReason?: string };
    };
    if (json.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
    const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    if (!text) throw new Error("Gemini returned no description");
    return { text, model };
  },
};

// ── OpenAI-compatible chat/vision adapters (images only) ───────────────────────────────────────────
function chatVisionAdapter(cfg: {
  id: ProviderId;
  label: string;
  endpoint: string;
  envNames: string[];
  key: () => string | null;
  model: () => string;
}): DescribeAdapter {
  return {
    id: cfg.id,
    label: cfg.label,
    supports: ["image"],
    apiKey: cfg.key,
    available() {
      return !!cfg.key();
    },
    async describe({ absPath, mimeType, prompt }) {
      const key = cfg.key();
      if (!key) throw new Error(`no ${cfg.label} API key`);
      const model = cfg.model();
      const data = readBase64Capped(absPath);
      const body = {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } },
            ],
          },
        ],
      };
      const json = (await postJson(cfg.endpoint, body, { authorization: `Bearer ${key}` })) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = (json.choices?.[0]?.message?.content ?? "").trim();
      if (!text) throw new Error(`${cfg.label} returned no description`);
      return { text, model };
    },
  };
}

const grok = chatVisionAdapter({
  id: "grok",
  label: "xAI Grok",
  endpoint: "https://api.x.ai/v1/chat/completions",
  envNames: ["XAI_API_KEY", "GROK_API_KEY"],
  key: () => getAppConfig().ai.grok.api_key || firstEnv("XAI_API_KEY", "GROK_API_KEY"),
  model: () => getAppConfig().ai.grok.model || "grok-2-vision-1212",
});

const openai = chatVisionAdapter({
  id: "openai",
  label: "OpenAI",
  endpoint: "https://api.openai.com/v1/chat/completions",
  envNames: ["OPENAI_API_KEY"],
  key: () => getAppConfig().ai.openai.api_key || firstEnv("OPENAI_API_KEY"),
  model: () => getAppConfig().ai.openai.model || "gpt-4o",
});

// Preference order: Gemini first (only one that covers video), then OpenAI, then Grok.
export const ADAPTERS: DescribeAdapter[] = [gemini, openai, grok];

/** Guess a mime type from the extension for the inline upload (best-effort; providers sniff too). */
export function mimeForMedia(absPath: string, kind: MediaKind): string {
  const ext = path.extname(absPath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".bmp": "image/bmp", ".heic": "image/heic", ".heif": "image/heif",
    ".avif": "image/avif", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".webm": "video/webm",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
    ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv",
  };
  return map[ext] ?? (kind === "video" ? "video/mp4" : "image/jpeg");
}

/** Pick the adapter to run: the requested one (if available + supports the kind), else the default, else
 *  the first available adapter that supports the kind. Returns null when nothing can run. */
export function selectAdapter(kind: MediaKind, requested?: ProviderId | "auto"): DescribeAdapter | null {
  const supports = (a: DescribeAdapter) => a.supports.includes(kind) && a.available();
  if (requested && requested !== "auto") {
    const a = ADAPTERS.find((x) => x.id === requested);
    if (a && supports(a)) return a;
  }
  const configured = getAppConfig().ai.provider;
  if (configured && configured !== "auto") {
    const a = ADAPTERS.find((x) => x.id === configured);
    if (a && supports(a)) return a;
  }
  return ADAPTERS.find(supports) ?? null;
}

/** The provider matrix the settings/viewer surfaces show (which are configured, what each supports). For
 *  Gemini we also flag when the resolved key came from the shared GoogleCloud key file (diagnostics). */
export function providerStatus(): DescribeProvider[] {
  const sources = providerKeySources();
  return ADAPTERS.map((a) => ({
    id: a.id,
    label: a.label,
    available: a.available(),
    supports: a.supports,
    usingFile: sources[a.id].usingFile,
  }));
}

/** Per-provider key SOURCE (for the Settings editor): a config-stored key vs. a resolved env var vs. the
 *  shared GoogleCloud key file (Gemini only). Never exposes the key value itself. */
export function providerKeySources(): Record<ProviderId, { hasConfigKey: boolean; usingEnv: boolean; usingFile: boolean; model: string }> {
  const c = getAppConfig().ai;
  const env = (names: string[]) => names.some((n) => !!(process.env[n] && process.env[n]!.trim()));
  const geminiConfig = !!c.gemini.api_key;
  const geminiEnv = !geminiConfig && env(["GEMINI_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_API_KEY"]);
  // The shared GoogleCloud/apikey.yaml is the last-resort Gemini source; it only "counts" when neither
  // config nor env already provides a key (mirrors the resolution order in gemini.apiKey()).
  const geminiFile = !geminiConfig && !geminiEnv && hasGoogleApiKeyFile();
  return {
    gemini: { hasConfigKey: geminiConfig, usingEnv: geminiEnv, usingFile: geminiFile, model: c.gemini.model },
    grok: { hasConfigKey: !!c.grok.api_key, usingEnv: !c.grok.api_key && env(["XAI_API_KEY", "GROK_API_KEY"]), usingFile: false, model: c.grok.model },
    openai: { hasConfigKey: !!c.openai.api_key, usingEnv: !c.openai.api_key && env(["OPENAI_API_KEY"]), usingFile: false, model: c.openai.model },
  };
}

/** The metadata (id/label/supports) for each adapter, in preference order. */
export function providerMeta(): Array<{ id: ProviderId; label: string; supports: MediaKind[]; available: boolean }> {
  return ADAPTERS.map((a) => ({ id: a.id, label: a.label, supports: a.supports, available: a.available() }));
}
