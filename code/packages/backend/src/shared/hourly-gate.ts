// HOURLY GATE for the heavy whole-repo passes (Bryan, 2026-11-16 — ~/BGit/all/film/bryan/why_slow.txt).
//
// THE INCIDENT. On 2026-11-16 the tower hit a 15-minute load average of 876 on 24 cores. Large File Bridge
// was one of the steady contributors: `storage.reconcile.yielding` on ~/BGit/all (259k tracked files) took
// 857 s in ONE call, and `storage.mirror` ran on it too. Both ran on EVERY pin pass (every 15 min), on EVERY
// backbone pull (the device worker every 10 min, the git-only sync trigger every artifact burst), and twice
// per repo inside the pin pass itself. loop-watch logged 2,842 reconcile and 2,063 mirror stalls.
//
// THE RULE. Per repo, per kind of heavy pass, run AT MOST ONCE PER HOUR. A call inside the window is not
// lost: it is remembered and ONE catch-up pass runs when the window opens (for callers that pass a
// `catchUp`), so a decision written now still reaches the sync repo — within the hour instead of at once.
//
// The last-run times are persisted (state dir, `hourly-gate.json`) so a `tsx watch` restart — which happens
// on every code edit — does not reset the clock and trigger the very storm this gate exists to stop.
//
// Tunable: LFB_REPO_HEAVY_MIN_INTERVAL_MS (milliseconds; 0 turns the gate off). Under vitest the gate is OFF
// by default so the existing specs keep asserting immediate reconcile/mirror; hourly-gate.spec.ts turns it
// on explicitly with setHourlyGateIntervalMs().
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { log } from "./logging.js";

export const ONE_HOUR_MS = 60 * 60 * 1000;

function defaultIntervalMs(): number {
  const env = process.env.LFB_REPO_HEAVY_MIN_INTERVAL_MS;
  if (env !== undefined && env !== "" && Number.isFinite(Number(env))) return Math.max(0, Number(env));
  return process.env.VITEST ? 0 : ONE_HOUR_MS;
}

let intervalMs = defaultIntervalMs();
const lastRun = new Map<string, number>();
const deferred = new Map<string, NodeJS.Timeout>();
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;

const gateFile = (): string => path.join(resolveStateDir(), "hourly-gate.json");

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(gateFile(), "utf8")) as { lastRun?: Record<string, number> };
    for (const [k, v] of Object.entries(raw.lastRun ?? {})) if (typeof v === "number") lastRun.set(k, v);
  } catch {
    /* absent/corrupt — an empty gate just means the next pass runs, which is always correct */
  }
}

function saveSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const file = gateFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ lastRun: Object.fromEntries(lastRun) }));
      fs.renameSync(tmp, file);
    } catch (e) {
      log.warn("storage", `hourly gate save failed (harmless): ${(e as Error).message}`);
    }
  }, 2_000);
  saveTimer.unref?.();
}

const keyOf = (kind: string, repoRoot: string): string => `${kind}\u0000${path.resolve(repoRoot)}`;

/**
 * May `kind` run on `repoRoot` now? When yes, the run is recorded (the window starts NOW). When no, and a
 * `catchUp` is given, exactly one catch-up is scheduled for when the window opens (repeat calls coalesce).
 */
export function hourlyGateAllows(kind: string, repoRoot: string, catchUp?: () => void): boolean {
  if (intervalMs <= 0) return true;
  load();
  const key = keyOf(kind, repoRoot);
  const now = Date.now();
  const last = lastRun.get(key);
  if (last === undefined || now - last >= intervalMs || last > now) {
    lastRun.set(key, now);
    const t = deferred.get(key);
    if (t) {
      clearTimeout(t);
      deferred.delete(key);
    }
    saveSoon();
    return true;
  }
  if (catchUp && !deferred.has(key)) {
    const wait = last + intervalMs - now;
    const t = setTimeout(() => {
      deferred.delete(key);
      lastRun.set(key, Date.now()); // the catch-up IS this window's run
      saveSoon();
      try {
        catchUp();
      } catch (e) {
        log.warn("storage", `hourly gate catch-up ${kind} on ${repoRoot} failed: ${(e as Error).message}`);
      }
    }, wait);
    t.unref?.();
    deferred.set(key, t);
    log.info(
      "storage",
      `${kind} on ${repoRoot} skipped: ran ${Math.round((now - last) / 60_000)} min ago (limit: once per ` +
        `${Math.round(intervalMs / 60_000)} min). One catch-up pass queued in ${Math.round(wait / 60_000)} min.`,
    );
  }
  return false;
}

/** TEST/OPS: set the window (0 = gate off) and forget all recorded runs and queued catch-ups. */
export function setHourlyGateIntervalMs(ms: number): void {
  intervalMs = Math.max(0, ms);
  resetHourlyGate();
}

/** TEST-ONLY: forget recorded runs and cancel queued catch-ups (does not change the interval). */
export function resetHourlyGate(): void {
  lastRun.clear();
  for (const t of deferred.values()) clearTimeout(t);
  deferred.clear();
  loaded = true; // a reset gate must not re-read the file and resurrect the runs it just forgot
}

/** TEST-ONLY: how many catch-ups are queued. */
export function hourlyGateDeferredCount(): number {
  return deferred.size;
}
