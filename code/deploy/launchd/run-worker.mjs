#!/usr/bin/env node
// launchd/cron trigger: POST the loopback-only run route so the work runs in the app's TS
// (scan.mdx §3.1 — deliberately Node, never raw curl). Args: <worker> <apiPort>.
//
// LOG FORMAT CONTRACT: the installed LaunchAgent points this process's stdout at log.log and its
// stderr at error.err (schedule.service.ts logOut/logErr). This script is dependency-free by design
// (launchd runs it directly; it cannot import the app's TS logger), so EVERY line it prints must
// carry the logger's `[ISO] [LEVEL] [context]` shape itself — a bare `run-worker pin: fetch failed`
// in error.err is unparseable and unattributable (the 2026-07-20 raw-line finding).
const worker = process.argv[2] || "pin";
const port = process.argv[3] || process.env.LFB_API_PORT || "8787";
const url = `http://127.0.0.1:${port}/api/internal/run/${worker}`;

const line = (level, msg) => `[${new Date().toISOString()}] [${level}] [run-worker] ${msg}\n`;

const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), 60_000);
try {
  const res = await fetch(url, { method: "POST", signal: ctrl.signal });
  if (!res.ok) {
    process.stderr.write(line("ERROR", `${worker}: backend answered HTTP ${res.status} for POST ${url}`));
    process.exit(1);
  }
  process.stdout.write(line("INFO", `${worker}: ok (POST ${url})`));
} catch (e) {
  const cause = e?.cause?.code || e?.cause?.message || e?.message || String(e);
  const unreachable = e?.message === "fetch failed" || e?.name === "AbortError";
  if (unreachable) {
    // The backend isn't running (or isn't answering) — an EXPECTED state between app sessions, not a
    // fault in this trigger. Say so with the URL and the underlying cause, then exit 0: launchd fires
    // on its interval regardless, and the app's own watchdog owns "worker overdue". A non-zero exit
    // here would only teach launchd to distrust a perfectly healthy trigger.
    process.stderr.write(
      line("WARN", `${worker}: backend unreachable at POST ${url} (${cause}) — app not running? Skipping this interval.`),
    );
    process.exit(0);
  }
  process.stderr.write(line("ERROR", `${worker}: POST ${url} failed: ${cause}`));
  process.exit(1);
} finally {
  clearTimeout(t);
}
