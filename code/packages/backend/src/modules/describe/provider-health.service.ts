// PROVIDER ACCOUNT HEALTH — the circuit breaker and the preflight probe (to_fix.mdx §2).
//
// This module exists because of the one fault in the 2026-07-15 incident that no other spec covers.
// memory.mdx asks "how many bytes may be in flight?" and answers it well. It never asks the prior
// question: WHY IS THIS WORK IN FLIGHT AT ALL?
//
// The timeline that makes the case:
//   19:49  Gemini prepayment credits deplete. Every call → 429 RESOURCE_EXHAUSTED, forever.
//   21:35  A 1,440-file batch is queued — 106 minutes AFTER the account died.
//   22:13  OOM. ~1,290 files silently lost.
// Not one file in that batch could ever have succeeded. The account had been dead for over an hour and
// nothing in the app knew or asked. A perfect byte budget would have made the crash survivable; it would
// still have described ZERO files.
//
// Two mechanisms, one job — never do doomed work:
//   * PREFLIGHT (§2.5) — before queuing N files, make ONE cheap call. Dead account → tell the user at the
//     click. A single probe at 21:35 would have prevented the entire incident.
//   * CIRCUIT BREAKER (§2.4) — if the account dies MID-batch (which is exactly what happened at 19:49, in
//     the middle of a run), the first file to notice opens the circuit and the queue halts the rest. The
//     alternative is 1,440 files each independently rediscovering the same fact.
//
// SEPARATION OF POWERS (to_fix.mdx §13): the ADAPTER classifies a fault (`classifyProviderFault`), this
// module holds the resulting STATE, and the QUEUE decides what to do about it. That is why nothing here
// throws or cancels — it records and answers questions. It also keeps the import graph acyclic: this file
// imports adapters.ts; adapters.ts must never import this one.
import type { ProviderId } from "./adapters.js";
import { ADAPTERS, classifyProviderFault } from "./adapters.js";
import { log } from "../../shared/logging.js";

/** Why a provider is refusing work — shown to the user verbatim, so it must be actionable prose.
 *
 *  `lastGoodAt` / `lastCheckedAt` are the CONTINUOUS half of the story (to_fix.mdx §2.6). `open` answers
 *  "is it dead right now"; these answer "when did it last work, and when did we last ask" — which is the
 *  question a user actually types at 08:00 ("why did nothing happen last night"). A provider that has never
 *  been asked and one that answered a minute ago are both `open: false`, and only these fields tell them
 *  apart. */
export interface CircuitState {
  open: boolean;
  reason: string | null;
  openedAt: string | null;
  lastGoodAt: string | null; // ISO — last time this provider actually SERVED a call or a probe
  lastCheckedAt: string | null; // ISO — last time we asked it anything at all (good or bad)
}

const circuits = new Map<ProviderId, CircuitState>();

function stateOf(p: ProviderId): CircuitState {
  let s = circuits.get(p);
  if (!s) {
    s = { open: false, reason: null, openedAt: null, lastGoodAt: null, lastCheckedAt: null };
    circuits.set(p, s);
  }
  return s;
}

/**
 * Open the circuit for a provider (to_fix.mdx §2.4). Called when a fault is classified `account_dead` —
 * the account cannot serve ANY request, so every queued file for this provider is doomed, not just the one
 * that noticed.
 *
 * Idempotent by design: 24 in-flight jobs will all fail at once when credits run out, and all 24 will call
 * this within the same second. The first one logs; the rest are absorbed silently. Without that, the very
 * event we built this to prevent — a flood of identical lines burying the signal — happens in the fault
 * handler itself (to_fix.mdx §4.5).
 */
export function openCircuit(provider: ProviderId, reason: string): boolean {
  const s = stateOf(provider);
  s.lastCheckedAt = new Date().toISOString(); // we asked and got an answer — a bad one still dates the check
  if (s.open) return false; // already open — absorb the other 23
  s.open = true;
  s.reason = reason;
  s.openedAt = new Date().toISOString();
  log.error(
    "provider-health",
    `CIRCUIT OPEN for ${provider}: ${reason}. This is an ACCOUNT-level fault — every queued ${provider} ` +
      `job is doomed, so the batch is being halted rather than retried (to_fix.mdx §2.4). Fix the account, ` +
      `then Resume. Queued work is marked "halted", NOT "failed" — it was never attempted and can be ` +
      `re-queued in one click.`,
  );
  return true;
}

/** Close the circuit — the user fixed the account and pressed Resume, or a probe succeeded (§2.4). */
export function closeCircuit(provider: ProviderId): void {
  const s = stateOf(provider);
  if (!s.open) return;
  s.open = false;
  s.reason = null;
  s.openedAt = null;
  preflightCache.delete(provider); // never answer a Resume from the cache that recorded the outage
  log.info("provider-health", `Circuit closed for ${provider} — work may flow again.`);
}

/**
 * Record that a provider just SERVED something (to_fix.mdx §2.6) — a real description or a probe. This is
 * the only writer of "last known good", and it is deliberately the mirror of `noteProviderFailure`: every
 * describe now ends in exactly one of the two, so health can never silently drift away from reality.
 *
 * It does NOT close an open circuit. A success while the circuit is open is possible (a straggler already
 * in flight when the account died, or a partially-restored account) and must not be enough on its own to
 * put the whole halted batch back on the wire — only a Resume, whose probe is fresh and deliberate, does
 * that (§2.4). Recording the timestamp is still right: it is true, and it is what the user reads.
 */
export function noteProviderSuccess(provider: ProviderId): void {
  const s = stateOf(provider);
  const now = new Date().toISOString();
  s.lastGoodAt = now;
  s.lastCheckedAt = now;
}

/** Is this provider refusing work right now? The queue asks this at ADMISSION, so a doomed task is never
 *  started (to_fix.mdx §2.4) — the cheapest possible failure is the one we never attempt. */
export function isCircuitOpen(provider: ProviderId): boolean {
  return stateOf(provider).open;
}

/** The reason a circuit is open, for the single user-facing banner (§2.4). */
export function circuitReason(provider: ProviderId): string | null {
  return stateOf(provider).reason;
}

/** Every provider's circuit state — the Settings → AI health surface (to_fix.mdx §2.6). */
export function circuitStatuses(): Record<string, CircuitState> {
  const out: Record<string, CircuitState> = {};
  for (const a of ADAPTERS) out[a.id] = { ...stateOf(a.id) };
  return out;
}

/**
 * Fold a describe failure into the circuit (to_fix.mdx §2.4). The ONE seam every per-file fault passes
 * through on its way out of `describeOne`, so the account-level case can never be missed by a caller that
 * forgot to check. Returns the classification so the caller can report it truthfully.
 */
export function noteProviderFailure(provider: ProviderId, e: unknown): ReturnType<typeof classifyProviderFault> {
  const kind = classifyProviderFault(e);
  if (kind === "account_dead") {
    const msg = e instanceof Error ? e.message : String(e);
    openCircuit(provider, friendlyReason(provider, msg));
  }
  return kind;
}

/** Never let an API key ride out in prose. Provider errors carry status + body, not the URL (adapters.ts
 *  logs host-only for exactly this reason), but a `?key=` can still reach us through a transport error that
 *  quotes the URL — and every string built here is destined for a log line AND a user-visible banner. One
 *  cheap scrub at the seam where raw text becomes prose (to_fix.mdx §2.4). */
function redactKeys(raw: string): string {
  return raw.replace(/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, "$1REDACTED");
}

/** Turn a raw provider error into something a human can act on. The raw text ("429 Too Many Requests:
 *  {...RESOURCE_EXHAUSTED...}") is true and useless; the user needs the VERB. */
function friendlyReason(provider: ProviderId, rawIn: string): string {
  const raw = redactKeys(rawIn);
  if (/credits? (are|is) depleted|prepayment|insufficient (funds|credits?|balance)|billing|payment/i.test(raw)) {
    const where = provider === "gemini" ? "ai.studio" : provider === "openai" ? "platform.openai.com" : "the provider's console";
    return `${provider} credits are depleted — top up at ${where}, then Resume.`;
  }
  if (/\b401\b|\b403\b|API key not valid|invalid api key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(raw)) {
    return `${provider} rejected the API key — check it in Settings → AI, then Resume.`;
  }
  return `${provider} is refusing work: ${raw.slice(0, 160)}`;
}

// ── preflight (to_fix.mdx §2.5) ───────────────────────────────────────────────────────────────────────

export interface PreflightResult {
  ok: boolean;
  reason: string | null;
}

interface CacheEntry {
  at: number;
  result: PreflightResult;
}

/** ~60s. Long enough that one probe covers a batch (the point — a probe per batch, never per file), short
 *  enough that a top-up is noticed promptly. */
const PREFLIGHT_TTL_MS = Math.max(5_000, Number(process.env.LFB_PREFLIGHT_TTL_MS) || 60_000);

const preflightCache = new Map<ProviderId, CacheEntry>();
/** Single-flight: a batch confirm can ask several times in the same tick; one probe answers them all. */
const inflightProbes = new Map<ProviderId, Promise<PreflightResult>>();

/**
 * Is this provider able to serve work RIGHT NOW? (to_fix.mdx §2.5)
 *
 * Cached + single-flighted, so this costs ONE tiny call per batch rather than one per file. A dead account
 * is reported at the click — which is the whole fix: the 2026-07-15 batch was queued 106 minutes after the
 * credits died, and a single call at that moment would have said so in about a second.
 *
 * FAIL-OPEN on anything that is not a clear account fault. If the probe times out or the network is down we
 * return ok — because refusing to queue a batch on the strength of a flaky probe would be a far more common
 * and more annoying failure than the one we are preventing. Only an UNAMBIGUOUS account fault blocks.
 */
export async function preflightProvider(provider: ProviderId): Promise<PreflightResult> {
  if (isCircuitOpen(provider)) {
    return { ok: false, reason: circuitReason(provider) };
  }
  const cached = preflightCache.get(provider);
  if (cached && Date.now() - cached.at < PREFLIGHT_TTL_MS) return cached.result;

  const running = inflightProbes.get(provider);
  if (running) return running;

  const p = runProbe(provider).finally(() => inflightProbes.delete(provider));
  inflightProbes.set(provider, p);
  return p;
}

async function runProbe(provider: ProviderId): Promise<PreflightResult> {
  const adapter = ADAPTERS.find((a) => a.id === provider);
  if (!adapter) return { ok: true, reason: null }; // unknown provider — not our call to block
  if (!adapter.available()) {
    return { ok: false, reason: `no API key configured for ${provider} — add one in Settings → AI.` };
  }
  let result: PreflightResult;
  try {
    await adapter.probe();
    noteProviderSuccess(provider); // the probe IS a served call — it dates last-known-good (§2.6)
    result = { ok: true, reason: null };
    log.info("provider-health", `preflight ${provider}: ok`);
  } catch (e) {
    stateOf(provider).lastCheckedAt = new Date().toISOString(); // we asked; the answer was just a bad one
    const kind = classifyProviderFault(e);
    if (kind === "account_dead") {
      const reason = friendlyReason(provider, e instanceof Error ? e.message : String(e));
      // The probe found a dead account: open the circuit NOW, so any work already queued stops too rather
      // than waiting to rediscover this one file at a time.
      openCircuit(provider, reason);
      result = { ok: false, reason };
    } else {
      // Fail OPEN (see above): a timeout or a blip must not block a batch the account could well serve.
      log.warn(
        "provider-health",
        `preflight ${provider} did not complete (${kind}): ${redactKeys((e as Error).message ?? "").slice(0, 140)} — allowing the batch anyway.`,
      );
      result = { ok: true, reason: null };
    }
  }
  preflightCache.set(provider, { at: Date.now(), result });
  return result;
}

// ── resume (to_fix.mdx §2.4 — "Close on user Resume or a successful probe") ───────────────────────────

export interface ResumeResult {
  resumed: boolean;
  reason: string | null;
  state: CircuitState;
}

/**
 * The user says they fixed the account: re-probe and, ONLY on a success, close the circuit (to_fix.mdx §2.4).
 *
 * This is the other half of `openCircuit` and it must not be skipped — without it a circuit can only be
 * closed by restarting the process, which means one depleted account silently disables AI descriptions for
 * the rest of the app's life. The user tops up their credits and the app keeps insisting they are broke.
 *
 * Three rules this function exists to enforce:
 *  1. **Probe for real.** `preflightProvider` deliberately short-circuits to `{ok:false}` while the circuit is
 *     open — it must never spend a call to re-learn what it already knows. That is exactly the wrong answer
 *     HERE, so this path calls the adapter directly and drops the cached entry that recorded the outage.
 *  2. **Never close blindly.** A Resume that trusted the click would re-queue 1,440 doomed files against a
 *     still-dead account — the precise failure this module exists to prevent, now user-triggered.
 *  3. **Never close on an unconfirmed probe.** This is the ONE place the §2.3 "prefer transient" bias does not
 *     apply. That bias protects a batch that is ALREADY moving from a false permanent verdict; here nothing is
 *     moving, and the choice is between "ask the user to click again" and "release doomed work on a hunch".
 *     A timeout is not a success, so the circuit stays open and the reason says we could not confirm.
 */
export async function resumeProvider(provider: ProviderId): Promise<ResumeResult> {
  const adapter = ADAPTERS.find((a) => a.id === provider);
  if (!adapter) return { resumed: false, reason: `unknown provider "${provider}"`, state: { ...stateOf(provider) } };

  if (!adapter.available()) {
    const reason = `no API key configured for ${provider} — add one in Settings → AI, then Resume.`;
    const s = stateOf(provider);
    if (!openCircuit(provider, reason)) s.reason = reason; // already open — keep the reason current
    log.info("provider-health", `resume ${provider}: refused — no key configured; circuit stays open.`);
    return { resumed: false, reason, state: { ...s } };
  }

  preflightCache.delete(provider); // never answer a Resume from the cache that recorded the outage
  try {
    await adapter.probe();
    noteProviderSuccess(provider);
    closeCircuit(provider);
    // Seed the cache with the fresh good news so the batch the user queues in the next second — which is the
    // whole point of pressing Resume — doesn't pay for a second probe.
    preflightCache.set(provider, { at: Date.now(), result: { ok: true, reason: null } });
    log.info("provider-health", `resume ${provider}: probe succeeded — circuit closed, work may flow again (to_fix.mdx §2.4).`);
    return { resumed: true, reason: null, state: { ...stateOf(provider) } };
  } catch (e) {
    const s = stateOf(provider);
    s.lastCheckedAt = new Date().toISOString();
    const kind = classifyProviderFault(e);
    const raw = e instanceof Error ? e.message : String(e);
    const reason =
      kind === "account_dead"
        ? friendlyReason(provider, raw)
        : `could not confirm ${provider} is healthy (${kind}): ${redactKeys(raw).slice(0, 140)} — the account was left halted; try Resume again.`;
    if (!openCircuit(provider, reason)) s.reason = reason; // refresh the prose; the circuit stays open either way
    log.warn("provider-health", `resume ${provider}: probe failed (${kind}) — circuit stays open: ${reason}`);
    return { resumed: false, reason, state: { ...s } };
  }
}
