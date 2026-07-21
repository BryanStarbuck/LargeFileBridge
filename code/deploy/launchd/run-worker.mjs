#!/usr/bin/env node
// launchd/cron trigger: POST the loopback-only run route so the work runs in the app's TS
// (scan.mdx §3.1 — deliberately Node, never raw curl). Args: <worker> <apiPort>.
//
// LOG FORMAT CONTRACT: the installed LaunchAgent points this process's stdout at log.log and its
// stderr at error.err (schedule.service.ts logOut/logErr). This script is dependency-free by design
// (launchd runs it directly; it cannot import the app's TS logger), so EVERY line it prints must
// carry the logger's `[ISO] [LEVEL] [context]` shape itself — a bare `run-worker pin: fetch failed`
// in error.err is unparseable and unattributable (the 2026-07-20 raw-line finding).
//
// WHAT THIS IS AND IS NOT (the 2026-07-21 fix). This is a KICK: the route accepts the job and returns
// immediately (internal.router.ts), and the real work runs detached inside the app. So the only thing
// waited on here is an ACKNOWLEDGEMENT, which takes milliseconds. Previously the `pin` and `device`
// routes awaited their whole pass inside the request, so this script sat on the socket for minutes,
// aborted at 60s, and wrote "backend unreachable … app not running? Skipping this interval." — three
// wrong claims at once: the app WAS running, an abort is a CLIENT-side timeout (never evidence the
// server is down), and nothing was skipped (the pass ran to completion behind the closed socket).
//
// So this script now DIAGNOSES rather than guesses, and distinguishes:
//   (a) connection refused / nothing listening  → the app genuinely is not running. Expected between
//       sessions. Record the missed cycle, exit 0.
//   (b) no ack in time, but the port IS accepting connections → the backend is alive. Say so, say the
//       run may well be underway, and NEVER claim the app is down.
//   (c) a socket torn down mid-flight (UND_ERR_SOCKET & friends) → transient. RETRY.
// In every undelivered case the missed fire is RECORDED in the state root so the app can surface it and
// recover it (worker-misses.service.ts, watchdog.service.ts) — a lost cycle never disappears silently.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const worker = process.argv[2] || "pin";
const port = process.argv[3] || process.env.LFB_API_PORT || "8787";
const url = `http://127.0.0.1:${port}/api/internal/run/${worker}`;

// The kick is an accept, not the work — 15s is already enormous for it. Deliberately NOT a big number:
// raising the timeout was the non-fix for this bug (it only lengthens the wrong-shaped wait).
// (Env-overridable ONLY so the regression test can exercise the slow/dead paths in milliseconds — the
// shipped values are the constants below; nothing in the app sets these.)
const ACK_TIMEOUT_MS = Number(process.env.LFB_WORKER_ACK_TIMEOUT_MS) || 15_000;
const ATTEMPTS = Number(process.env.LFB_WORKER_ATTEMPTS) || 3;
const RETRY_BACKOFF_MS = process.env.LFB_WORKER_ACK_TIMEOUT_MS ? [50, 50] : [2_000, 5_000];

const line = (level, msg) => `[${new Date().toISOString()}] [${level}] [run-worker] ${msg}\n`;
const out = (level, msg) => (level === "INFO" ? process.stdout : process.stderr).write(line(level, msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The state root, resolved exactly as the app resolves it (config/state-dir.ts). Kept in lockstep by
// hand because this file must stay dependency-free.
function stateDir() {
  try {
    return process.env.LFB_STATE_DIR || path.join(os.homedir(), "T", "_large_files_bridge");
  } catch {
    return "/tmp/_large_files_bridge";
  }
}

/**
 * Record a fire that never reached the backend, so it is RECOVERABLE rather than merely logged. The app
 * reads this file into the background-process transparency UI and its watchdog acts on it. Writing to
 * disk is the only channel that works in case (a) — when the app is down there is nobody to tell.
 */
function recordMiss(reason, detail) {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "worker-misses.json");
    let all = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") all = parsed;
    } catch {
      // absent or unparseable — start fresh
    }
    const prior = all[worker] && typeof all[worker].consecutive === "number" ? all[worker].consecutive : 0;
    all[worker] = { at: new Date().toISOString(), reason, detail, consecutive: prior + 1 };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, file);
    return all[worker].consecutive;
  } catch (e) {
    out("WARN", `${worker}: could not record the missed cycle: ${e?.message || String(e)}`);
    return 1;
  }
}

/** Is anything actually accepting TCP connections on the API port right now? The (a)-vs-(b) discriminator. */
function portIsAccepting(timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port: Number(port) });
    const done = (answer) => {
      sock.destroy();
      resolve(answer);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

// Classify a fetch rejection. `fetch failed` is a wrapper — the truth is in e.cause.code.
function classify(e) {
  const code = e?.cause?.code || "";
  const detail = code || e?.cause?.message || e?.message || String(e);
  if (e?.name === "AbortError") return { kind: "timeout", detail: "no acknowledgement within timeout" };
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EADDRNOTAVAIL", "ENETUNREACH"].includes(code)) {
    return { kind: "refused", detail };
  }
  if (
    ["UND_ERR_SOCKET", "ECONNRESET", "EPIPE", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)
  ) {
    return { kind: "socket", detail };
  }
  return { kind: "other", detail };
}

async function kickOnce() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ACK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", signal: ctrl.signal });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(t);
  }
}

let last = { kind: "other", detail: "no attempt made" };
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    const res = await kickOnce();
    if (res.ok) {
      // The backend ACCEPTED the job. It is now running detached in the app and will stamp its own
      // last-run on completion — this process's work is done and it exits without waiting for it.
      out("INFO", `${worker}: accepted by the app (POST ${url})${attempt > 1 ? ` on attempt ${attempt}` : ""} — the run continues in the background`);
      process.exit(0);
    }
    // The backend answered and refused. Not a connectivity problem; retrying won't help.
    recordMiss("http-error", `HTTP ${res.status}`);
    out("ERROR", `${worker}: the app refused this run — HTTP ${res.status} for POST ${url}`);
    process.exit(1);
  } catch (e) {
    last = classify(e);
    // (a) refused: nothing is listening. Retrying inside one fire cannot conjure a running app — stop now.
    if (last.kind === "refused") break;
    // (b)/(c): transient or ambiguous — a second try costs nothing and covers a socket teardown or a
    // momentary stall during app startup.
    if (attempt < ATTEMPTS) {
      out("INFO", `${worker}: ${last.kind === "timeout" ? "no acknowledgement" : `socket problem (${last.detail})`} on attempt ${attempt} — retrying`);
      await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 5_000);
    }
  }
}

// Undelivered after every attempt. Report the RIGHT one of the three states — the whole point of this fix.
const alive = await portIsAccepting();

if (last.kind === "refused" && !alive) {
  // (a) The app genuinely is not running — an EXPECTED state between app sessions, not a fault in this
  // trigger. Exit 0: launchd fires on its interval regardless, and the app recovers the missed cycle on
  // its next boot (watchdog.service.ts). A non-zero exit would only teach launchd to distrust a healthy job.
  const n = recordMiss("app-not-running", last.detail);
  out("WARN", `${worker}: Large File Bridge is not running (nothing listening on 127.0.0.1:${port}, ${last.detail}) — this cycle did not run. Recorded; the app recovers it when it next starts.${n > 1 ? ` (${n} cycles in a row)` : ""}`);
  process.exit(0);
}

if (last.kind === "timeout") {
  // (b) The backend did not acknowledge, but the port IS accepting connections (or the abort was ours and
  // the app's liveness is unknown). Either way this is a CLIENT-side timeout — it is NOT evidence the app
  // is down, and it does NOT mean the cycle was skipped: the POST may well have been received and the run
  // may be underway right now. Say exactly that and nothing more.
  const n = recordMiss("ack-timeout", last.detail);
  out(
    "WARN",
    `${worker}: no acknowledgement from the app within ${ACK_TIMEOUT_MS / 1000}s over ${ATTEMPTS} attempts` +
      `${alive ? " — but 127.0.0.1:" + port + " IS accepting connections, so the app is running and busy" : " and the port is not answering either"}. ` +
      `The kick may already have been received and the run may be in progress; this is NOT a skipped cycle claim. Recorded for the app to reconcile.${n > 1 ? ` (${n} in a row)` : ""}`,
  );
  process.exit(0);
}

// (c) Socket teardown that survived every retry, or an unrecognized failure. Record it and report it as
// what it is — a connection fault — without diagnosing the app's state we cannot see.
const n = recordMiss(last.kind === "socket" ? "socket-error" : "app-not-running", last.detail);
out(
  "WARN",
  `${worker}: could not deliver this cycle to the app after ${ATTEMPTS} attempts (${last.detail})` +
    `${alive ? ` — 127.0.0.1:${port} is accepting connections, so the app is up` : ` — 127.0.0.1:${port} is not accepting connections`}. Recorded for recovery.${n > 1 ? ` (${n} in a row)` : ""}`,
);
process.exit(0);
