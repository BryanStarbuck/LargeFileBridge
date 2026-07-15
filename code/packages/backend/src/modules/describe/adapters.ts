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
import { DEFAULT_GEMINI_MODEL, DEFAULT_GROK_MODEL, DEFAULT_OPENAI_MODEL, looksLikeModelRetired } from "./models.js";
import { log } from "../../shared/logging.js";

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

// ASYNC read (fs.promises) so encoding an up-to-18MB file to base64 never blocks the Node event loop —
// under the describe queue's ~24-way concurrency (job_queue.mdx §3) a synchronous read per in-flight file
// would stall GET /api/progress and every other request (ai_description.mdx §3.3.1, performance.mdx P-27).
async function readBase64Capped(absPath: string): Promise<string> {
  const size = fs.statSync(absPath).size; // one fast stat — the gate before the big read
  if (size > INLINE_MAX_BYTES) {
    throw new Error(
      `file is ${(size / (1024 * 1024)).toFixed(1)}MB — over the ${INLINE_MAX_BYTES / (1024 * 1024)}MB inline limit for AI description. Compress it first, then try again.`,
    );
  }
  return (await fs.promises.readFile(absPath)).toString("base64");
}

/** Rewrite a provider's raw HTTP error into an actionable one when it looks like the configured model was
 *  retired/unknown (a 404 / "no longer available" / NOT_FOUND). Names the bad model and the current
 *  recommended default so the user can fix it in Settings → AI. Otherwise returns the error unchanged. */
function explainModelError(e: Error, model: string, provider: string): Error {
  const msg = e?.message ?? String(e);
  if (looksLikeModelRetired(msg)) {
    const recommended = provider === "Gemini" ? DEFAULT_GEMINI_MODEL : provider === "OpenAI" ? DEFAULT_OPENAI_MODEL : DEFAULT_GROK_MODEL;
    return new Error(
      `${provider} model "${model}" is not available — the provider may have retired it. ` +
        `Update the model in Settings → AI (recommended: ${recommended}). Original error: ${msg}`,
    );
  }
  return e;
}

// ── transient-failure policy (ai_description.mdx §3.5) ───────────────────────────────────────────────
// A hosted vision call fails for two very different reasons, and conflating them is what lost a 1,800-file
// batch overnight: a PERMANENT fault (bad key, retired model, unsupported media, safety block) will fail
// identically forever, while a TRANSIENT one (timeout under load, provider 429/5xx, a dropped socket) would
// have succeeded moments later. The queue records a failure per file and moves on — nothing retries — so a
// transient blip permanently marks the file "not described" and the user's only clue is a failed dock card
// among 1,800 others. Every transient class below is therefore retried with exponential backoff + jitter
// BEFORE the failure is allowed to escape to the queue.

/** How many total attempts a single provider call gets (1 try + 3 retries). */
const MAX_ATTEMPTS = 4;
/** Base backoff; doubled per attempt and jittered, so 24 in-flight jobs don't retry in lockstep. */
const RETRY_BASE_MS = 2_000;

/**
 * True when an error is worth trying again — a timeout, a socket-level fetch failure, a 429, or a 5xx…
 * …and ALSO the provider's **empty 200**: a well-formed response that simply carries no description text.
 * That one is easy to mistake for a permanent verdict ("the model won't describe this file") but it is
 * not — the SAME video that came back empty described perfectly on the very next attempt, `finishReason:
 * STOP`, 1,877 tokens of text. An empty candidate is the provider having a bad moment, so it retries like
 * any other blip. (A genuine refusal is different and stays permanent: it arrives as an explicit
 * `blockReason` / safety verdict, which does NOT match here.)
 */
function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/blocked the request|blockReason|SAFETY|PROHIBITED/i.test(msg)) return false; // a real refusal — permanent
  return (
    /AbortError|timed out|This operation was aborted/i.test(msg) ||
    /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(msg) ||
    /\b429\b|rate limit|RESOURCE_EXHAUSTED|quota/i.test(msg) ||
    /\b5\d\d\b\s|internal error|unavailable|overloaded/i.test(msg) ||
    /returned no description|returned non-JSON/i.test(msg)
  );
}

/** The provider's own "wait this long" hint, in ms, when it sent one (Retry-After: seconds | HTTP-date). */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The request timeout for a payload. A FIXED timeout is wrong here because the payloads differ by two
 * orders of magnitude: a 200KB thumbnail and a 17.5MB video get the same deadline, so the deadline is
 * either far too slack for the thumbnail or too tight for the video the moment the link is busy. Scale it
 * with the bytes being uploaded, on a generous floor.
 */
function timeoutForBytes(bytes: number): number {
  const perMb = 20_000; // 20s per MB of upload — generous for a slow link
  return Math.min(10 * 60_000, 120_000 + Math.floor((bytes / (1024 * 1024)) * perMb));
}

/** One fetch attempt with a hard timeout so a hung provider call can't wedge the request forever. */
async function postJsonOnce(url: string, payload: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: payload,
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = retryAfterMs(res);
      const err = new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`) as Error & { retryAfterMs?: number };
      if (hint != null) err.retryAfterMs = hint;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`provider returned non-JSON: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    // Name the real failure. Node's bare "This operation was aborted" told the user nothing about WHY a
    // file was skipped — it is a timeout, and the message should say so, with the deadline it blew.
    if (e instanceof Error && /abort/i.test(`${e.name}: ${e.message}`)) {
      throw new Error(`provider call timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** ONE POST attempt with a size-scaled timeout. The retry lives at the adapter seam (`withProviderRetry`),
 *  not here — because the provider's **empty 200** is thrown by the adapter AFTER this call returns fine,
 *  and it deserves a retry just as much as a dropped socket does. Retrying here would miss it. */
async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const payload = JSON.stringify(body);
  return postJsonOnce(url, payload, headers, timeoutForBytes(payload.length));
}

/**
 * Run one whole provider call with bounded retry on TRANSIENT failures only (§3.5). This wraps the ENTIRE
 * `adapter.describe()` — the HTTP round-trip *and* the response interpretation — so every transient class
 * is covered by one policy: timeouts, 429/5xx, dropped sockets, and the empty-200 that only becomes an
 * error once the adapter reads the (perfectly valid) response. Permanent faults — a bad key, a retired
 * model, a safety refusal — throw on the FIRST attempt; retrying them only makes the user wait.
 */
export async function withProviderRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || attempt === MAX_ATTEMPTS) break;
      const hinted = (e as { retryAfterMs?: number })?.retryAfterMs;
      const backoff = hinted ?? RETRY_BASE_MS * 2 ** (attempt - 1);
      const jittered = Math.floor(backoff * (0.5 + Math.random()));
      log.warn("describe", `${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${(e as Error).message?.slice(0, 140)} — retrying in ${Math.round(jittered / 1000)}s`);
      await sleep(jittered);
    }
  }
  throw lastErr;
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
    const model = getAppConfig().ai.gemini.model || DEFAULT_GEMINI_MODEL;
    const data = await readBase64Capped(absPath);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data } }] }],
    };
    let json: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      promptFeedback?: { blockReason?: string };
    };
    try {
      json = (await postJson(url, body, {})) as typeof json;
    } catch (e) {
      // Turn Google's raw 404 ("... is no longer available ... NOT_FOUND") into an actionable message
      // that names the retired model and the current recommended one (ai_description.mdx §5.1).
      throw explainModelError(e as Error, model, "Gemini");
    }
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
      const data = await readBase64Capped(absPath);
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
      let json: { choices?: Array<{ message?: { content?: string } }> };
      try {
        json = (await postJson(cfg.endpoint, body, { authorization: `Bearer ${key}` })) as typeof json;
      } catch (e) {
        throw explainModelError(e as Error, model, cfg.label);
      }
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
  model: () => getAppConfig().ai.grok.model || DEFAULT_GROK_MODEL,
});

const openai = chatVisionAdapter({
  id: "openai",
  label: "OpenAI",
  endpoint: "https://api.openai.com/v1/chat/completions",
  envNames: ["OPENAI_API_KEY"],
  key: () => getAppConfig().ai.openai.api_key || firstEnv("OPENAI_API_KEY"),
  model: () => getAppConfig().ai.openai.model || DEFAULT_OPENAI_MODEL,
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
