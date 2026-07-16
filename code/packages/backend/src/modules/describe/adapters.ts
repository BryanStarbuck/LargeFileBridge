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
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { MediaKind, DescribeProvider } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { loadGoogleApiKey, hasGoogleApiKeyFile } from "../../config/google-apikey-file.js";
import { DEFAULT_GEMINI_MODEL, DEFAULT_GROK_MODEL, DEFAULT_OPENAI_MODEL, looksLikeModelRetired } from "./models.js";
import { log } from "../../shared/logging.js";
import { txnBegin, txnEnd } from "../../shared/transactions.js";

export type ProviderId = "gemini" | "grok" | "openai";

export interface DescribeInput {
  absPath: string;
  kind: MediaKind; // "image" | "video" (audio is not described here)
  mimeType: string;
  prompt: string;
  /** The owning `describe` txn id, so this call's `provider_call` ledger pair carries `parent=` and one
   *  `grep <txn>` reconstructs the file's whole story out of 24 interleaved siblings (transactions_log.mdx §4). */
  parent?: string;
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
  /**
   * PREFLIGHT (to_fix.mdx §2.5): the cheapest call that proves this account can actually serve work RIGHT
   * NOW. Throws on failure, exactly like `describe`, so `classifyProviderFault` reads its error the same way.
   *
   * It must exercise the **quota/billing path**, not merely the auth path — that is the whole point. A
   * models-list call 200s on a credit-dead account and would have cheerfully waved the 2026-07-15 batch
   * through; a real (tiny) generation is the only thing that gets a truthful answer, and it costs a handful
   * of tokens once per batch rather than 1,440 doomed uploads.
   */
  probe(): Promise<void>;
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

// ── the upload payload path — MEMORY DISCIPLINE (memory.mdx P-29) ────────────────────────────────────
// One file used to be resident THREE to FOUR times over at once here, and that is what killed the backend on
// 2026-07-15: an 18MB file became ~18MB of raw Buffer + ~24MB of base64 + ~24MB of data-URL (a second full
// copy made by a template concat) + ~24MB of stringified JSON — ~66-90MB per in-flight file, times the
// queue's ~24-way concurrency (job_queue.mdx §3) ≈ 1.6-2.2GB, against a 4.1GB heap ceiling. P-28 and P-29
// are one bug seen from two ends: the multiplier is what made the concurrency lethal rather than merely wide.
//
// The rule from here down: BUILD THE PAYLOAD ONCE.
//   * The raw Buffer dies the moment the base64 string exists — the two are never co-resident (below).
//   * Nothing holds a `data` local ALONGSIDE the body that embeds it. The base64 goes straight into the
//     body literal, so there is exactly one root keeping it alive.
//   * The data-URL prefix is concatenated onto that same single string rather than copied into a second one.
// The honest floor: an INLINE base64 API forces ONE copy of the encoded bytes plus JSON.stringify's
// serialization of it (postJson, below). We kill copies 2-4; copy 1 and the stringify are structural.
// FOLLOW-UP (the real fix): switching to a STREAMING / multipart upload — Gemini's resumable Files API, a
// multipart body fed from a read stream — removes the JSON.stringify copy and the base64 inflation both, and
// would take the per-file resident cost from ~4x the file size to ~a fixed buffer. That is a wire-contract
// change and deliberately NOT done here.

// ASYNC read (fs.promises) so encoding an up-to-18MB file to base64 never blocks the Node event loop —
// under the describe queue's ~24-way concurrency (job_queue.mdx §3) a synchronous read per in-flight file
// would stall GET /api/progress and every other request (ai_description.mdx §3.3.1, performance.mdx P-27).
//
// `prefix` (optional) is prepended to the encoded bytes as part of the SAME string. The OpenAI-compatible
// adapters need a `data:<mime>;base64,` header on their payload; building it here means the caller never
// holds the bare base64 and the prefixed copy at the same time (memory.mdx P-29 — this was copy #3).
async function readBase64Capped(absPath: string, prefix = ""): Promise<string> {
  const size = fs.statSync(absPath).size; // one fast stat — the gate before the big read
  if (size > INLINE_MAX_BYTES) {
    throw new Error(
      `file is ${(size / (1024 * 1024)).toFixed(1)}MB — over the ${INLINE_MAX_BYTES / (1024 * 1024)}MB inline limit for AI description. Compress it first, then try again.`,
    );
  }
  // The raw Buffer and the base64 string must NOT both stay reachable across the return (memory.mdx P-29):
  // holding both is ~42MB of live heap for an 18MB file, per in-flight job. Null the Buffer out the instant
  // the encode is done so it is collectable before the caller ever assembles the request body.
  let buf: Buffer | null = await fs.promises.readFile(absPath);
  const encoded = prefix + buf.toString("base64");
  buf = null;
  return encoded;
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

// ── the 429 that is NOT a rate limit (to_fix.mdx §2.3) ────────────────────────────────────────────────
// On 2026-07-15 the Gemini account's prepayment credits ran out at 19:49. Every call after that returned
// `429 RESOURCE_EXHAUSTED`. The old classifier below matched `\b429\b|RESOURCE_EXHAUSTED|quota` and called
// it TRANSIENT, so a 1,440-file batch queued at 21:35 — 106 minutes after the account died — retried every
// single file 4× with backoff against an account that could not possibly answer. ~5,760 doomed calls.
//
// That was not merely wasteful, it was the CRASH: every retry re-enters describe(), re-reads, re-encodes,
// and holds a fresh ~48MB payload, while backoff keeps the slot occupied ~4× longer. The queue therefore
// sat PINNED at 24-in-flight at maximum residency — precisely the condition memory.mdx P-28 computes as
// fatal. The byte budget makes that survivable; this classifier makes it not happen.
//
// TWO faults arrive as the SAME HTTP 429 and only the BODY tells them apart:
//   * rate limit      — "too fast". TRANSIENT. Wait, retry, succeed. Retrying is CORRECT.
//   * credits gone    — "account empty". PERMANENT until a human tops up. Retrying is pure waste.
//
// BIAS (to_fix.mdx §2.3): when ambiguous, prefer TRANSIENT. A false "permanent" strands a recoverable
// batch, which is worse than a few wasted retries. So this pattern is deliberately NARROW — it matches
// only unmistakable account-level language, never a bare "quota exceeded" (which Gemini also uses for
// ordinary per-minute rate limits on the free tier).
const ACCOUNT_DEAD_RE =
  /prepayment credits? (are|is) depleted|credits? (are|is) depleted|insufficient (funds|credits?|balance)|billing account|account (is )?(not active|suspended|disabled)|payment (required|method)/i;

/** What KIND of fault a provider call hit. The adapter CLASSIFIES; the queue DECIDES what to do about it
 *  (to_fix.mdx §13) — which is why this returns a verdict instead of reaching for the circuit breaker. */
export type ProviderFaultKind = "transient" | "permanent" | "account_dead";

/**
 * Classify a provider failure (to_fix.mdx §2.3).
 *
 * * `account_dead` — the ACCOUNT cannot serve any request: credits depleted, billing disabled, suspended.
 *   Permanent for every file, not just this one, so it must halt the whole batch (§2.4) rather than burn
 *   1,440 files discovering the same fact 1,440 times.
 * * `permanent` — this FILE will fail identically forever: safety refusal, retired model, bad key.
 * * `transient` — would likely succeed moments later: timeout, socket drop, rate limit, 5xx, empty-200.
 */
export function classifyProviderFault(e: unknown): ProviderFaultKind {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);

  // A real refusal — an explicit safety verdict. Permanent for this file, but the account is fine.
  if (/blocked the request|blockReason|SAFETY|PROHIBITED/i.test(msg)) return "permanent";

  // The account-level fault. Gated on rate-limit-shaped status AND unmistakable billing language, so an
  // ordinary "429 quota exceeded" rate limit can never be mistaken for a dead account.
  const rateLimitShaped = /\b429\b|rate limit|RESOURCE_EXHAUSTED|quota/i.test(msg);
  if (rateLimitShaped && ACCOUNT_DEAD_RE.test(msg)) {
    // A provider that sends Retry-After is telling us to WAIT — i.e. it expects to serve us later. That is
    // a rate limit wearing billing words; believe the header over the prose and keep retrying.
    if ((e as { retryAfterMs?: number })?.retryAfterMs == null) return "account_dead";
  }
  // A 401/403 is an auth/permission fault: a bad or revoked key. No amount of retrying fixes it, and it is
  // account-level (every file fails), so it halts the batch exactly like depleted credits does.
  if (/\b401\b|\b403\b|API key not valid|invalid api key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) {
    return "account_dead";
  }

  const transient =
    /AbortError|timed out|This operation was aborted/i.test(msg) ||
    /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(msg) ||
    rateLimitShaped ||
    /\b5\d\d\b\s|internal error|unavailable|overloaded/i.test(msg) ||
    /returned no description|returned non-JSON/i.test(msg);
  return transient ? "transient" : "permanent";
}

/**
 * True when an error is worth trying again — a timeout, a socket-level fetch failure, a 429, or a 5xx…
 * …and ALSO the provider's **empty 200**: a well-formed response that simply carries no description text.
 * That one is easy to mistake for a permanent verdict ("the model won't describe this file") but it is
 * not — the SAME video that came back empty described perfectly on the very next attempt, `finishReason:
 * STOP`, 1,877 tokens of text. An empty candidate is the provider having a bad moment, so it retries like
 * any other blip. (A genuine refusal is different and stays permanent: it arrives as an explicit
 * `blockReason` / safety verdict, which does NOT match here.)
 *
 * Now a thin read of `classifyProviderFault` so there is exactly ONE place that decides what a fault is.
 */
function isTransient(e: unknown): boolean {
  return classifyProviderFault(e) === "transient";
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

/** Everything a `provider_call` ledger line is allowed to know about the call it is describing
 *  (transactions_log.mdx §3.4 — a FIXED allow-list; a value not on it does not reach the file). */
interface CallMeta {
  provider: ProviderId;
  model: string;
  parent?: string;
}

/** URL **host only** — NEVER the full URL. Gemini accepts `?key=` in the query string, so logging a URL
 *  would leak the API key by accident (transactions_log.mdx §9). This is the reason §3.4 mandates `host`. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/**
 * The retry attempt currently in flight, carried across the awaits between `withProviderRetry` and the
 * `fetch` it eventually drives. An AsyncLocalStorage rather than a parameter because the attempt number has
 * to cross `adapter.describe()` — a public seam whose signature belongs to the adapter contract, not to the
 * ledger. Instrumentation must not reshape the API it observes (transactions_log.mdx §5.4).
 */
const attemptCtx = new AsyncLocalStorage<number>();

/** A failure reason SLUG for the ledger — status/shape only. NEVER the response body: the body is the
 *  provider's error text and may echo the request (transactions_log.mdx §3.3, §9). */
function callFailureReason(status: number, e: unknown): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/abort|timed out/i.test(msg)) return "timeout";
  if (status >= 400) return `http_${status}`;
  if (/non-JSON/i.test(msg)) return "non_json";
  return "network";
}

/** One fetch attempt with a hard timeout so a hung provider call can't wedge the request forever.
 *  This is ALSO the single site where every outbound provider request is ledgered — one `provider_call`
 *  BEGIN/END pair per attempt, covering gemini/grok/openai and every future adapter for free
 *  (transactions_log.mdx §5.3). Before this, a Gemini call that SUCCEEDED logged absolutely nothing; the
 *  only log statement in this file fired on a transient retry, so you learned a call had happened only if
 *  it went wrong. Host + sizes + status only — never the key, never the payload, never the response text. */
async function postJsonOnce(
  url: string,
  payload: string,
  headers: Record<string, string>,
  timeoutMs: number,
  meta: CallMeta,
): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  // txnBegin/txnEnd by hand rather than txn(): txn()'s failure path would put the thrown error's MESSAGE in
  // `reason=`, and this call's error message carries a 400-char slice of the provider's response body. The
  // ledger must never hold a body (§9), so we END with our own slug instead.
  const tx = txnBegin("provider_call", {
    parent: meta.parent,
    host: hostOf(url),
    provider: meta.provider,
    model: meta.model,
    attempt: attemptCtx.getStore() ?? 1,
    maxAttempts: MAX_ATTEMPTS,
    reqBytes: Buffer.byteLength(payload),
  });
  let status = 0; // stays 0 when the fetch never got one — a timeout/DNS/socket failure (§3.4)
  let respBytes = 0;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: payload,
      signal: ac.signal,
    });
    status = res.status;
    const text = await res.text();
    respBytes = Buffer.byteLength(text);
    if (!res.ok) {
      const hint = retryAfterMs(res);
      const err = new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`) as Error & { retryAfterMs?: number };
      if (hint != null) err.retryAfterMs = hint;
      throw err;
    }
    try {
      const json = JSON.parse(text);
      txnEnd(tx, "ok", { status, respBytes });
      return json;
    } catch {
      throw new Error(`provider returned non-JSON: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    txnEnd(tx, "failed", { status, respBytes, reason: callFailureReason(status, e) });
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
async function postJson(url: string, body: unknown, headers: Record<string, string>, meta: CallMeta): Promise<unknown> {
  // The unavoidable second copy (memory.mdx P-29): an inline base64 API means the encoded bytes exist once
  // inside `body` and once again serialized here, both live for the whole round-trip. Killing THIS copy is
  // the streaming/multipart follow-up noted at the payload path above — it is not a comment-away problem.
  const payload = JSON.stringify(body);
  return postJsonOnce(url, payload, headers, timeoutForBytes(payload.length), meta);
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
      // Each attempt is its OWN provider_call BEGIN/END pair carrying attempt=N maxAttempts=M
      // (transactions_log.mdx §5.4) — a retried call is N pairs, never one long line, so 3 × 30s of wall
      // time spent on one file is countable instead of merely suspected. The number rides an
      // AsyncLocalStorage down to the fetch; the adapter seam in between never sees it.
      return await attemptCtx.run(attempt, fn);
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
  /** A 1-token generation — the cheapest call that still touches billing/quota (to_fix.mdx §2.5). */
  async probe() {
    const key = this.apiKey();
    if (!key) throw new Error("no Gemini API key");
    const model = getAppConfig().ai.gemini.model || DEFAULT_GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    // We never read the answer — a 200 of ANY shape means the account is alive and funded. Only the THROW
    // matters here, and `postJson` throws on every non-2xx, carrying the body that classifyProviderFault reads.
    await postJson(
      url,
      { contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } },
      {},
      { provider: "gemini", model },
    );
  },
  async describe({ absPath, mimeType, prompt, parent }) {
    const key = this.apiKey();
    if (!key) throw new Error("no Gemini API key");
    const model = getAppConfig().ai.gemini.model || DEFAULT_GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    // The base64 goes STRAIGHT into the body — no `data` local held alongside it, so the encoded bytes have
    // exactly one root and the raw Buffer is already gone by the time we get here (memory.mdx P-29).
    const body = {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: await readBase64Capped(absPath) } }] }],
    };
    let json: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      promptFeedback?: { blockReason?: string };
    };
    try {
      json = (await postJson(url, body, {}, { provider: "gemini", model, parent })) as typeof json;
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
    /** A 1-token completion — the cheapest call that still touches billing/quota (to_fix.mdx §2.5). */
    async probe() {
      const key = cfg.key();
      if (!key) throw new Error(`no ${cfg.label} API key`);
      const model = cfg.model();
      await postJson(
        cfg.endpoint,
        { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
        { authorization: `Bearer ${key}` },
        { provider: cfg.id, model },
      );
    },
    async describe({ absPath, mimeType, prompt, parent }) {
      const key = cfg.key();
      if (!key) throw new Error(`no ${cfg.label} API key`);
      const model = cfg.model();
      // The data-URL prefix is built INTO the encode (readBase64Capped's `prefix`) and dropped straight into
      // the body. The old `` `data:${mime};base64,${data}` `` template made a SECOND full copy of the base64
      // while the bare `data` local kept the first one alive for the whole call — ~24MB × 24 jobs of pure
      // duplicate (memory.mdx P-29, copy #3). Same bytes on the wire; one copy instead of two.
      const body = {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: await readBase64Capped(absPath, `data:${mimeType};base64,`) } },
            ],
          },
        ],
      };
      let json: { choices?: Array<{ message?: { content?: string } }> };
      try {
        json = (await postJson(cfg.endpoint, body, { authorization: `Bearer ${key}` }, { provider: cfg.id, model, parent })) as typeof json;
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
