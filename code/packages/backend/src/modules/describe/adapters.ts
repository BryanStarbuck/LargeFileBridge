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
import { Agent } from "undici";
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

// ── the REFUSAL and its evidence (ai_description.mdx §2.3) ────────────────────────────────────────────
//
// When the model REFUSES a file, the provider is telling us something specific and permanent about THAT
// file — and it is the only party that knows why. That answer is the whole value of the event, and we used
// to throw all of it away: the adapter reduced a rich refusal to the string "returned no description", so
// the `finishMessage` explaining *which* rule fired never reached the user. §2.3 requires us to keep every
// detail the provider sent, so `rejection` carries the parsed highlights AND the untouched `raw` response.
//
// The provider's response body is SAFE to persist here — it is Google's answer about the user's own file,
// written to the user's own sidecar. That is not in tension with transactions_log.mdx §9 (never a body, never
// a key in the LEDGER): §9 governs the ledger, and this never goes there. The API key rides the URL's
// `?key=`, never the response, so nothing secret can land in the file.

/** The refusing `finishReason`s — the model declining to emit what it generated. A refusal is PERMANENT
 *  (see `classifyProviderFault` — reversed 2026-07-20; it used to retry): it fails on attempt 1 and EARNS
 *  its `.ai_description_rejected` record immediately (§2.3). A plain `STOP` with no text is a blip, not a
 *  refusal, and must never be recorded as one — it stays transient and retries. */
const REFUSAL_FINISH_REASONS = new Set(["RECITATION", "SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);
export function isRefusalFinishReason(reason: string | null | undefined): boolean {
  return !!reason && REFUSAL_FINISH_REASONS.has(reason.toUpperCase());
}

// ── RECITATION is the ONE refusal that a DIFFERENT ASK can still answer (ai_description.mdx §3.5) ─────
//
// The refusals are not all the same shape of "no":
//   * SAFETY / PROHIBITED_CONTENT / BLOCKLIST / SPII / IMAGE_SAFETY — a verdict about the FILE. Asking
//     again, however phrased, gets the same verdict. Re-asking is pure waste (and, for a safety verdict,
//     is us trying to talk the model out of its own policy — we do not do that).
//   * RECITATION — a verdict about the RESPONSE TEXT: the model generated something that looked like
//     recited training data and suppressed it. The file was fine; the words were the problem. A DIFFERENT
//     wording is genuinely a different question, and the sampled generator will usually take a different
//     path when asked for original phrasing at a higher temperature (measured on this corpus: one slide,
//     10 identical calls → 6 described, 4 RECITATION).
//
// So RECITATION — and ONLY RECITATION — earns exactly ONE deliberate re-ask with a VARIED prompt. This is
// emphatically NOT the generic retry loop that was removed on 2026-07-20: that loop re-sent the IDENTICAL
// request up to 4 times and could not do anything but reproduce the same suppression. Budget: 1 extra call,
// once, inside the adapter. If the re-ask is refused too, the refusal escapes on attempt 1 exactly as
// before and earns its `.ai_description_rejected` record.
export function isRecitationFinishReason(reason: string | null | undefined): boolean {
  return !!reason && reason.toUpperCase() === "RECITATION";
}

/** Appended to the prompt for the single RECITATION re-ask. It changes what we are ASKING FOR (original
 *  wording, no quoting of text visible in the media) rather than repeating the same request louder — the
 *  suppression was triggered by the response text resembling existing material, so the fix has to live in
 *  the instruction. Kept short so it can never crowd out the user's own (possibly customized) prompt. */
export const RECITATION_REASK_SUFFIX =
  "\n\nImportant: describe this in your own original wording. Do not quote or reproduce any wording, lyrics, " +
  "poetry, code, or passages of text that appear in the media or that resemble an existing published work — " +
  "paraphrase and summarize them instead. Write plain, factual, original prose.";

/** Everything the provider told us about a refusal. `raw` is the provider's ENTIRE response, so a detail we
 *  never thought to parse is still on disk for the user to read (§2.3). */
export interface ProviderRejection {
  provider: ProviderId;
  model: string;
  finishReason: string | null;
  finishMessage: string | null;
  blockReason: string | null;
  safetyRatings?: unknown;
  promptFeedback?: unknown;
  usageMetadata?: unknown;
  modelVersion?: string | null;
  responseId?: string | null;
  raw: unknown;
}

/** Ride the rejection on the Error itself. The refusal surfaces through `adapter.describe()`'s throw, and a
 *  second return channel would mean reshaping the adapter contract for every provider (§5.4's rule: don't
 *  reshape the API you observe). `rejectionOf()` is the one reader. */
export function attachRejection(e: Error, rejection: ProviderRejection): Error {
  (e as Error & { rejection?: ProviderRejection }).rejection = rejection;
  return e;
}

/** The provider's refusal evidence, when this error IS a refusal — else null (an ordinary fault, a timeout,
 *  a dead account). Presence of this object is what decides whether a `.ai_description_rejected` is written,
 *  which is why it is set ONLY where the provider actually refused: a retired model or a revoked key is a
 *  broken CONFIG, not a verdict about the file, and must never litter the tree with rejection records. */
export function rejectionOf(e: unknown): ProviderRejection | null {
  return (e as { rejection?: ProviderRejection })?.rejection ?? null;
}

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

  // A REFUSAL we have structured evidence for (§2.3) — classify off the object, never off the prose. The
  // message now names the finishReason, and "…(finishReason: PROHIBITED_CONTENT)" would trip the safety
  // regex below purely by wording. Structure decides; text is for humans.
  const rejection = rejectionOf(e);
  if (rejection) {
    // ANY structured refusal is PERMANENT — the input-side `blockReason` (refused before generation) and
    // the output-side refusing `finishReason` alike: attempt 1, no retries, straight to the
    // `.ai_description_rejected` record (§2.3).
    //
    // REVERSED 2026-07-20: this branch used to classify an output-side refusal "transient" on the strength
    // of one measurement (one slide, 10 identical calls → 6 described / 4 `RECITATION` — generation is
    // sampled, so the filter looked like a coin toss). In production the re-roll did not pay: refusing
    // files burned all 4 attempts plus backoff and were rejected anyway (2026-07-20 error.err — every
    // RECITATION file walked attempts 1→4 before earning the same rejection record), hundreds of wasted
    // provider calls per batch and minutes of delay per file. A refusal now costs ONE call. The record
    // stays supersedable, and Overwrite (§2.3) is the deliberate way to re-roll a file the sampling may
    // yet describe.
    return "permanent";
  }

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
 * any other blip.
 *
 * A genuine REFUSAL does NOT retry (reversed 2026-07-20 — it used to). Gemini refuses with an empty
 * candidate carrying nothing but a refusing `finishReason` (`RECITATION`, `SAFETY`, …), and although
 * generation is sampled, production showed refusing files burning all 4 attempts plus backoff only to be
 * rejected anyway. So a structured refusal classifies "permanent": it fails on attempt 1 and writes its
 * `.ai_description_rejected` immediately (§2.3), which Overwrite can supersede later. The blank `STOP`
 * empty-200 above stays transient — it carries no refusal evidence.
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

// ── the pooled-connection stall (ai_description.mdx §3.6) ─────────────────────────────────────────────
//
// Node's global `fetch` keeps a per-origin undici Pool and REUSES its keep-alive sockets. Against
// generativelanguage.googleapis.com under concurrency, a request handed to an already-used socket can sit
// in the pool's queue UNSENT until our own AbortController fires — the failure surfaces as
// "provider call timed out after 120s" and looks exactly like a slow provider. It is not: the socket never
// carried the request.
//
// Measured on the 2026-07-16 batch, 48 real files, 24-way, identical file list and same wall-clock:
//                                     requests sent   queue(create->sendHeaders) p90   outcome
//   pooled reuse (Node default)          35/48                 121.3s                  18 TIMEOUTS
//   fresh connection per request         48/48                   0.1s                  48 ok, wall 51s
//   python control (new conn per req)    48/48                     —                   48 ok
// Time spent WAITING ON GOOGLE was identical in every arm (sendHeaders->response p50 ~22s, max ~28s), and
// event-loop lag peaked at 6ms — the provider was never slow and we were never CPU-blocked. Lowering
// concurrency to 8 made it WORSE (queue p50 98.6s): fewer sockets, more reuse. `connections: 64`,
// `pipelining: 0`, `keepAliveTimeout: 1` and `Connection: close` ALL failed to fix it, because undici
// reuses a socket the moment it is free and none of those knobs govern that path. Only genuinely
// declining reuse works.
//
// So each provider call gets its OWN Agent, closed in `finally`. The cost is one TLS handshake (~0.1s) per
// call — under 1% of a ~22s describe — and it buys back the 27% failure rate and 3x the wall time.
// Scoped deliberately to provider calls: the IPFS client talks to 127.0.0.1 at low concurrency and is not
// affected.
//
// A fresh connection removes the POOL stall, but a socket can still die AFTER the handshake (silent drop,
// dead peer) — and with undici's own timers disabled that stall used to ride all the way to the app
// deadline: 120–123s burned per attempt, ×4 attempts. So the Agent now carries its own fail-fast clocks,
// all well UNDER the app deadline, so a stalled socket errors early and the retry — which builds a brand
// new Agent, so it can never land on the same dead socket — gets a fresh connection while there is still
// deadline budget left. The AbortController's timeoutForBytes stays as the LAST-RESORT ceiling only.
function freshProviderDispatcher(timeoutMs: number): Agent {
  return new Agent({
    connections: 1, // this Agent serves exactly ONE request, so its pool can never hand out a used socket
    connectTimeout: 15_000, // a fresh TCP+TLS handshake per call; 10s (undici's default) was tripping on bursts
    // Headers wait = upload + the provider's full non-streaming inference (measured p50 ~22s, max ~28s on
    // the 2026-07-16 batch), so a fixed ~30s would clip real responses. Half the size-scaled app deadline
    // (60s on the 120s floor, more for big videos) keeps >2x headroom over the measured max while cutting
    // a stalled socket's cost in half or better. undici holds this timer while the request body is still
    // being written, so slow uploads don't false-trip it.
    headersTimeout: Math.floor(timeoutMs / 2),
    bodyTimeout: 30_000, // gap BETWEEN response-body chunks — once JSON starts flowing, 30s of silence is a dead socket
    // Moot while every Agent is destroyed in `finally` after one request, but cheap insurance if this
    // dispatcher is ever shared: never hand out a socket that has sat idle long enough to be dead.
    keepAliveTimeout: 4_000,
    keepAliveMaxTimeout: 30_000,
  });
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
  const dispatcher = freshProviderDispatcher(timeoutMs); // §3.6 — never reuse a pooled socket for a provider call
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
    // `dispatcher` is undici's option, not WHATWG's, so it is absent from the DOM RequestInit type.
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: payload,
      signal: ac.signal,
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
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
    // The Agent's fail-fast clocks surface through fetch as a bare "TypeError: fetch failed" with the real
    // error hidden in `cause`. Unwrap the two timeout codes so the log names the stall (and the ledger slug
    // reads "timeout", not "network") — the message keeps "timed out" so the existing transient
    // classification retries it unchanged, on a brand-new connection.
    const causeCode = (e as { cause?: { code?: string } })?.cause?.code;
    const stalled =
      causeCode === "UND_ERR_HEADERS_TIMEOUT"
        ? new Error(
            `provider call timed out after ${Math.round(timeoutMs / 2000)}s waiting for response headers (stalled socket — retry gets a fresh connection)`,
          )
        : causeCode === "UND_ERR_BODY_TIMEOUT"
          ? new Error(`provider call timed out mid-response: 30s with no body data (stalled socket — retry gets a fresh connection)`)
          : null;
    txnEnd(tx, "failed", { status, respBytes, reason: callFailureReason(status, stalled ?? e) });
    if (stalled) throw stalled;
    // Name the real failure. Node's bare "This operation was aborted" told the user nothing about WHY a
    // file was skipped — it is a timeout, and the message should say so, with the deadline it blew.
    if (e instanceof Error && /abort/i.test(`${e.name}: ${e.message}`)) {
      throw new Error(`provider call timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(t);
    // Release the socket this Agent owns. `close()` waits for in-flight work and would hang on the abort
    // path, so tear it down outright — the request is over either way, and a leaked Agent is a leaked fd.
    void dispatcher.destroy().catch(() => {});
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

// ── thinking budget (ai_description.mdx §3.7) ─────────────────────────────────────────────────────────
//
// DEFAULT_GEMINI_MODEL is the `gemini-flash-latest` ALIAS, and Google hot-swaps it forward. It now resolves
// to gemini-3.5-flash, a THINKING model that reasons before answering unless told not to — so this app
// silently started paying for reasoning it never asked for the day Google moved the alias. Measured on this
// corpus: ~1,400 thinking tokens per image and p50 27s → 16s with thinking off, output length unchanged
// (~1,200 tokens). Describing what is in a picture is perception, not deduction; the thinking tokens buy
// nothing here and cost latency on every file of a 483-file batch.
//
// This is a SPEED/COST fix, not the timeout fix — §3.6's pooled-socket stall was the failure (§3.7). It matters
// anyway: it is ~40% off the wall time of every batch and ~676k thinking tokens off a 483-file run.
const NO_THINKING = { thinkingConfig: { thinkingBudget: 0 } };

// The alias moves under us, so this must not be a one-way bet. A future Flash could REQUIRE a non-zero
// budget and reject ours with a 400 — which would break every describe, a worse outcome than the tokens we
// are saving. So a 400 that names the thinking config is treated as "this model won't take it": we latch it
// off for the rest of the process and retry the call plain. Self-healing beats a pin we would have to
// notice and edit.
let thinkingBudgetRejected = false;
function looksLikeThinkingRejected(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b400\b/.test(msg) && /thinking|thinkingBudget|thinkingConfig/i.test(msg);
}

// ── Gemini (Google) — the only adapter that describes VIDEO as well as images ──────────────────────

/** The slice of `generateContent`'s response this adapter reads. The WHOLE object is still what lands in
 *  `ProviderRejection.raw`, so a field absent here is never a field lost from the record (§2.3). */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    finishMessage?: string;
    safetyRatings?: unknown;
  }>;
  promptFeedback?: { blockReason?: string; safetyRatings?: unknown };
  usageMetadata?: unknown;
  modelVersion?: string;
  responseId?: string;
}

/** The description text in a Gemini response — "" when the candidate carried none (the empty-200 / refusal
 *  shape). Parts are concatenated because a long answer arrives split across several of them. */
function geminiText(json: GeminiResponse): string {
  return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
}

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
    // `promptPart` is held by reference so the RECITATION re-ask below can vary the WORDS without rebuilding
    // (i.e. re-reading and re-encoding) the payload — the uploaded bytes are the same file either way.
    const promptPart: { text: string } = { text: prompt };
    const body: Record<string, unknown> = {
      contents: [{ parts: [promptPart, { inline_data: { mime_type: mimeType, data: await readBase64Capped(absPath) } }] }],
    };
    if (!thinkingBudgetRejected) body.generationConfig = { ...NO_THINKING };

    // ONE round-trip, including the self-healing thinking-budget fallback. Factored out because the
    // RECITATION re-ask sends the same body a second time and must get the identical treatment.
    const send = async (): Promise<GeminiResponse> => {
      try {
        return (await postJson(url, body, {}, { provider: "gemini", model, parent })) as GeminiResponse;
      } catch (e) {
        // This model won't take a zero thinking budget — latch it off and serve the file plain (§5.2).
        if (!thinkingBudgetRejected && looksLikeThinkingRejected(e)) {
          thinkingBudgetRejected = true;
          log.warn("describe", `Gemini model "${model}" rejected thinkingBudget:0 — describing without it for the rest of this run`);
          const cfg = { ...((body.generationConfig as Record<string, unknown>) ?? {}) };
          delete cfg.thinkingConfig;
          if (Object.keys(cfg).length > 0) body.generationConfig = cfg;
          else delete body.generationConfig;
          try {
            return (await postJson(url, body, {}, { provider: "gemini", model, parent })) as GeminiResponse;
          } catch (retryErr) {
            // The replayed call reaches the same model, so it can fail the same actionable way — a retired-model
            // 404 escaping raw here would be the ONE path that skips §5.1's explanation (the `else` below wraps
            // every other throw). Same treatment, whichever attempt surfaced it.
            throw explainModelError(retryErr as Error, model, "Gemini");
          }
        }
        // Turn Google's raw 404 ("... is no longer available ... NOT_FOUND") into an actionable message
        // that names the retired model and the current recommended one (ai_description.mdx §5.1).
        throw explainModelError(e as Error, model, "Gemini");
      }
    };

    let json = await send();
    let text = geminiText(json);
    if (text) return { text, model };

    // ── the single deliberate RECITATION re-ask (§3.5) ────────────────────────────────────────────────
    // Only when the model suppressed its OWN OUTPUT for recitation, and only when the INPUT was accepted
    // (a `blockReason` is a verdict on the upload — nothing about the wording can move it). Exactly one
    // extra call, with a varied prompt and a raised temperature so the sampler cannot walk the same path
    // it just suppressed. Everything else — SAFETY, BLOCKLIST, PROHIBITED_CONTENT, and the blank `STOP`
    // empty-200 — falls straight through to the throw below, unchanged.
    if (!json.promptFeedback?.blockReason && isRecitationFinishReason(json.candidates?.[0]?.finishReason)) {
      promptPart.text = prompt + RECITATION_REASK_SUFFIX;
      // Temperature is the knob that makes the re-ask a different draw rather than a rerun of the same one.
      body.generationConfig = { ...((body.generationConfig as Record<string, unknown>) ?? {}), temperature: 1.0 };
      log.info("describe", `Gemini suppressed its answer for ${path.basename(absPath)} (RECITATION) — re-asking ONCE for original phrasing`);
      json = await send();
      text = geminiText(json);
      if (text) {
        log.info("describe", `the RECITATION re-ask for ${path.basename(absPath)} succeeded (${text.length} chars)`);
        return { text, model };
      }
    }

    // Everything Google said about this refusal, kept whole for the `.ai_description_rejected` record (§2.3).
    const rejection = (): ProviderRejection => ({
      provider: "gemini",
      model,
      finishReason: json.candidates?.[0]?.finishReason ?? null,
      finishMessage: json.candidates?.[0]?.finishMessage ?? null,
      blockReason: json.promptFeedback?.blockReason ?? null,
      safetyRatings: json.candidates?.[0]?.safetyRatings,
      promptFeedback: json.promptFeedback,
      usageMetadata: json.usageMetadata,
      modelVersion: json.modelVersion ?? null,
      responseId: json.responseId ?? null,
      raw: json,
    });

    if (json.promptFeedback?.blockReason) {
      throw attachRejection(new Error(`Gemini blocked the request: ${json.promptFeedback.blockReason}`), rejection());
    }
    const finishReason = json.candidates?.[0]?.finishReason;
    // NAME the finishReason when there is no text. The empty-200 retry policy is right for a candidate that
    // simply came back blank (finishReason STOP) — but Gemini also returns an empty candidate to REFUSE, and
    // a refusal is permanent. Without the reason in the message every refusal read as "returned no
    // description" → transient → 4 attempts × ~30s of certain failure per file, and those wasted failures
    // counted toward the batch ceiling (jobqueue §2.7) that halted the rest of the batch. Measured at ~3% of
    // calls on this corpus (RECITATION on slide/document images, the odd PROHIBITED_CONTENT).
    // classifyProviderFault() reads the ATTACHED evidence and sorts the permanent reasons from the retryable ones.
    const err = new Error(`Gemini returned no description (finishReason: ${finishReason ?? "none"})`);
    // ONLY a refusing finishReason earns the rejection record. A blank candidate with `STOP` is the
    // provider having a bad moment (§3.5) — it retries and usually succeeds, so writing it a rejection
    // file would record a verdict the provider never reached.
    throw isRefusalFinishReason(finishReason) ? attachRejection(err, rejection()) : err;
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
