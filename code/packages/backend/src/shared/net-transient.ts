// A LAPTOP CHANGING WIFI IS NOT A FAULT (charter, "Local storage & logging": `error.err` is the DURABLE
// FAULT TRAIL — WARN/ERROR/FATAL only).
//
// The defect this module exists to kill, read straight off `error.err` for 2026-07-18 → 2026-07-21:
//
//   [WARN] [pin] storage personal git: Git remote error … 'https://github.com/…': Could not resolve host: github.com
//   [WARN] [pin] device-reg storage … 'https://github.com/…': Resolving timed out after 900230 milliseconds
//   [WARN] [sync] …/charlie-kirk: converge failed: fatal: unable to access '…': Resolving timed out after 1021876 ms
//
// Every one of those is a closed lid, a sleeping wifi radio, or a DNS resolver that had not woken up yet —
// EXPECTED and self-healing. Two things were wrong with how we handled them:
//
//   1. They were written into the durable fault trail at the SAME severity as a real remote failure (a bad
//      credential, a deleted repo), so the file that is supposed to be the short list of things that need a
//      human became mostly weather.
//   2. Worse — the cycle was simply LOST. The storage cycle returned, the converge throttle was stamped as
//      "attempted", and nothing retried until the next 15-minute tick (or, for a page-load converge, the
//      next 30-minute throttle window). A 2-second DNS blip cost a whole sync cycle.
//
// So: name the shape, and give callers a way to be woken when connectivity is actually back instead of
// guessing an interval. `whenOnline()` polls the OS resolver for the very host the git remote failed on
// (no HTTP request, no traffic to anyone else's machine — consistent with the no-relay posture) and fires
// each waiter once its host resolves again, with a hard ceiling so a waiter can never leak.
import dns from "node:dns";
import { log } from "./logging.js";

/**
 * True when a git/network error message is the machine being OFFLINE or DNS being briefly unavailable —
 * recoverable on its own, never a reason to mark anything failed.
 *
 * Deliberately narrow: an auth failure, a 404 remote, a rejected push and a protocol error must all keep
 * their WARN. Everything here is "there was no usable network at the moment we tried".
 */
export function isTransientNetworkError(message: string): boolean {
  const m = message || "";
  return (
    /Could not resolve host/i.test(m) ||
    /Resolving timed out/i.test(m) ||
    /Temporary failure in name resolution/i.test(m) ||
    /Name or service not known/i.test(m) ||
    /\b(EAI_AGAIN|ENOTFOUND|ENETDOWN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE_NET)\b/.test(m) ||
    /Network is unreachable/i.test(m) ||
    /Connection (timed out|reset by peer|refused)/i.test(m) ||
    /Failed to connect to .* port/i.test(m) ||
    /Operation timed out/i.test(m) ||
    /Empty reply from server/i.test(m) ||
    /gnutls_handshake\(\) failed|SSL_ERROR_SYSCALL|LibreSSL SSL_connect/i.test(m) ||
    /unable to access '[^']*': (Failed|Could not|Recv failure|Send failure|Operation)/i.test(m)
  );
}

/**
 * The remote HOST a git error was about — `fatal: unable to access 'https://github.com/x/y.git/': …`
 * → `github.com`. Also understands the scp-like SSH shape (`git@github.com:x/y.git`). Null when the
 * message names no host; callers then fall back to a generic reachability probe.
 */
export function hostFromGitError(message: string): string | null {
  const m = message || "";
  const url = /'((?:https?|ssh|git):\/\/[^']+)'/i.exec(m)?.[1] ?? /((?:https?|ssh|git):\/\/\S+)/i.exec(m)?.[1];
  if (url) {
    try {
      return new URL(url).hostname || null;
    } catch {
      /* fall through to the scp shape */
    }
  }
  const scp = /(?:^|[\s'"])[\w.-]+@([\w.-]+):/.exec(m)?.[1];
  return scp ?? null;
}

/** The host a configured remote points at (URL or `git@host:path`), for waiters that have the remote itself. */
export function hostFromRemote(remote: string | null | undefined): string | null {
  const r = (remote ?? "").trim();
  if (!r) return null;
  if (/^(https?|ssh|git):\/\//i.test(r)) {
    try {
      return new URL(r).hostname || null;
    } catch {
      return null;
    }
  }
  return /^[\w.-]+@([\w.-]+):/.exec(r)?.[1] ?? null;
}

/** How often we ask the OS resolver whether a waiter's host is reachable again. */
export const PROBE_INTERVAL_MS = 30_000;
/** A waiter never lives longer than this — it runs anyway at the ceiling so nothing is lost for good. */
export const MAX_WAIT_MS = 20 * 60_000;
/** Host used when the failure named none — any well-known name answers the "is DNS alive" question. */
const FALLBACK_HOST = "github.com";

interface Waiter {
  host: string;
  queuedAt: number;
  run: () => void;
}

const waiters = new Map<string, Waiter>();
let timer: NodeJS.Timeout | null = null;

/** Resolve a hostname through the OS resolver only — no HTTP, no third-party traffic. */
async function resolves(host: string): Promise<boolean> {
  try {
    await dns.promises.lookup(host);
    return true;
  } catch {
    return false;
  }
}

function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function probeOnce(): Promise<void> {
  if (waiters.size === 0) return stop();
  const hosts = new Set([...waiters.values()].map((w) => w.host));
  const online = new Set<string>();
  for (const h of hosts) if (await resolves(h)) online.add(h);
  const now = Date.now();
  for (const [key, w] of [...waiters.entries()]) {
    const expired = now - w.queuedAt >= MAX_WAIT_MS;
    if (!online.has(w.host) && !expired) continue;
    waiters.delete(key);
    log.info(
      "net",
      `${key}: ${expired ? "network never came back within the wait ceiling — retrying anyway" : `${w.host} resolves again — retrying the cycle the outage cost us`}`,
    );
    try {
      w.run();
    } catch (e) {
      log.warn("net", `${key}: retry-on-reconnect threw: ${(e as Error).message}`);
    }
  }
  if (waiters.size === 0) stop();
}

/**
 * Run `run` as soon as `host` resolves again (or at the {@link MAX_WAIT_MS} ceiling) — the retry that
 * turns a lost cycle into a delayed one. Re-registering the same `key` REPLACES the pending waiter (one
 * retry per storage/repo, never a pile), and registering is idempotent while the probe loop is running.
 */
export function whenOnline(key: string, host: string | null, run: () => void): void {
  const first = waiters.size === 0;
  waiters.set(key, { host: host || FALLBACK_HOST, queuedAt: Date.now(), run });
  if (first || !timer) {
    stop();
    timer = setInterval(() => void probeOnce(), PROBE_INTERVAL_MS);
    timer.unref?.();
  }
}

/** TEST-ONLY: how many retries are waiting on connectivity. */
export function pendingOnlineWaiters(): number {
  return waiters.size;
}

/** TEST-ONLY: drop every waiter and stop the probe loop. */
export function resetOnlineWaitersForTest(): void {
  waiters.clear();
  stop();
}

/** TEST-ONLY: run one probe pass now instead of waiting for the interval. */
export async function probeOnlineWaitersForTest(): Promise<void> {
  await probeOnce();
}
