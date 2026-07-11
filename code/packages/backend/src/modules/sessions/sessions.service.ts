// Web-session tracking + the > 48h "stale return" auto-pin (sessions.mdx).
//
// A "web session" is a usage window measured from page renders — NOT the auth session (storage.mdx
// §10). The frontend pings on every render; we fold pings into one open session and, once 4 hours pass
// with no render, discontinue it (back-dated to the LAST render). The whole point: when a NEW session
// STARTS on a computer that has not pinned in > 48h, kick off a NON-BLOCKING pin pass so the
// user is not working against stale files.
import type { SessionActivityResult, SessionRecord } from "@lfb/shared";
import { getUserConfig, updateUserConfig } from "../store-model/user-config.service.js";
import { getAppConfig } from "../store-model/config.service.js";
import { listRepoFolders, getRepoStatus } from "../store-model/units.service.js";
import { pinAll } from "../pin/pin.service.js";
import { log } from "../../shared/logging.js";

const HOUR_MS = 60 * 60 * 1000;
const IDLE_MS = 4 * HOUR_MS; // sessions.mdx §2.2 — 4-hour idle window
const STALE_MS = 48 * HOUR_MS; // sessions.mdx §3 — 48-hour stale threshold
const MAX_SESSIONS = 5; // sessions.mdx §4 — keep the last five, newest first

// One idle timer per user (in-memory; the backend is single-instance, storage.mdx §10). Rearmed on
// every ping; when it fires with no intervening activity it discontinues the open session.
const idleTimers = new Map<string, NodeJS.Timeout>();

// A single guard so a near-simultaneous stale return can't launch two overlapping auto-pins
// (sessions.mdx §3.1 / invariant 6). Module-scope = process-wide, which is what we want here.
let autoPinInFlight = false;

/** "Last pinned" (sessions.mdx §1): newest of the scheduled worker's last run and every repo's
 *  status.yaml last_pin_at (a manual "Pin now" only writes the latter). null ⇒ never pinned. */
export function lastPinAt(): Date | null {
  let newest: number | null = null;
  const consider = (iso: string | null | undefined): void => {
    if (!iso) return;
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  };
  consider(getAppConfig().pin_process.last_run_at);
  for (const folder of listRepoFolders()) {
    try {
      consider(getRepoStatus(folder).last_pin_at);
    } catch {
      // An unreadable/half-written unit status must not break freshness detection — skip it.
    }
  }
  return newest === null ? null : new Date(newest);
}

/**
 * Record one render/navigation ping for `email`. Extends the open session, or (after a >4h gap, or on
 * a first-ever ping) starts a new one and, if this machine is >48h stale, fires a non-blocking pin pass.
 */
export async function recordActivity(email: string): Promise<SessionActivityResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  let newSession = false;

  await updateUserConfig(email, (c) => {
    const sessions = c.sessions;
    // Self-heal (invariant 2): only the newest entry (index 0) may be open. Anything deeper that is
    // still open — from a hand-edit, an older layout, or a concurrency edge — is closed here, back-dated
    // to its own last render (invariant 3). We never trust stored session state blindly.
    for (let i = 1; i < sessions.length; i++) {
      if (sessions[i].ended_at === null) sessions[i].ended_at = sessions[i].last_activity_at;
    }
    const open = sessions[0] && sessions[0].ended_at === null ? sessions[0] : null;
    if (open && withinIdle(open.last_activity_at, now)) {
      open.last_activity_at = nowIso; // still going — extend the current session
    } else {
      // No open session, or the "open" one has been idle past the window and the timer never fired
      // (e.g. the server was down): close it — back-dated to its last render — and begin a new one.
      if (open) open.ended_at = open.last_activity_at;
      sessions.unshift({ started_at: nowIso, last_activity_at: nowIso, ended_at: null });
      newSession = true;
    }
    c.sessions = sessions.slice(0, MAX_SESSIONS); // keep only the last five, newest first
    return c;
  });

  armIdleTimer(email);

  // Staleness is checked ONLY when a new session starts (invariant 4) → at most one auto-pin per return.
  const last = lastPinAt();
  let autoPinTriggered = false;
  if (newSession && isStale(last, now)) autoPinTriggered = triggerAutoPin(email, last);

  return { newSession, autoPinTriggered, lastPinAt: last ? last.toISOString() : null };
}

function withinIdle(lastActivityIso: string, now: Date): boolean {
  const t = Date.parse(lastActivityIso);
  if (Number.isNaN(t)) return false; // unparseable timestamp ⇒ treat the session as not-open
  return now.getTime() - t <= IDLE_MS;
}

function isStale(last: Date | null, now: Date): boolean {
  if (!last) return true; // never pinned ⇒ infinitely stale
  return now.getTime() - last.getTime() > STALE_MS;
}

/** (Re)arm the 4-hour idle timer. When it fires with no further activity, discontinue the session. */
function armIdleTimer(email: string): void {
  const existing = idleTimers.get(email);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    void closeIdleSession(email);
  }, IDLE_MS);
  // Don't let a pending idle timer keep the Node process alive on shutdown.
  if (typeof t.unref === "function") t.unref();
  idleTimers.set(email, t);
}

/** Timer callback: end the open session at its last render (never at the timer's fire time). Idempotent
 *  — the same close is also computed lazily by the next ping, so a missed timer is harmless. */
async function closeIdleSession(email: string): Promise<void> {
  idleTimers.delete(email);
  try {
    await updateUserConfig(email, (c) => {
      const open = c.sessions[0];
      if (open && open.ended_at === null && !withinIdle(open.last_activity_at, new Date())) {
        open.ended_at = open.last_activity_at; // back-dated to the last render (sessions.mdx §2.2)
      }
      return c;
    });
    log.info("sessions", `Idle-closed web session for ${email} (4h no activity).`);
  } catch (e) {
    log.warn("sessions", `Failed to idle-close session for ${email}: ${(e as Error).message}`);
  }
}

/** Fire a non-blocking whole-computer pin pass on a stale return. Never awaited by the caller; guarded so
 *  only one runs at a time (sessions.mdx §3.1). Returns whether this call actually started one. */
function triggerAutoPin(email: string, last: Date | null): boolean {
  if (autoPinInFlight) {
    log.info("sessions", `Stale return for ${email}, but an auto-pin is already in flight — skipping.`);
    return false;
  }
  autoPinInFlight = true;
  const age = last ? `${Math.round((Date.now() - last.getTime()) / HOUR_MS)}h since last pin` : "never pinned";
  log.info("sessions", `Stale return (${age}) for ${email} — auto-kicking a background pin pass.`);
  void pinAll()
    .then(() => log.info("sessions", "Auto-pin on stale return complete."))
    .catch((e) => log.error("sessions", `Auto-pin on stale return failed: ${(e as Error).message}`))
    .finally(() => {
      autoPinInFlight = false;
    });
  return true;
}

/** The last five web sessions for a user, newest first (for the UI / diagnostics). */
export function getSessions(email: string): SessionRecord[] {
  return getUserConfig(email).sessions;
}
