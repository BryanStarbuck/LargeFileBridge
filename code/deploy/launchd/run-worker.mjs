#!/usr/bin/env node
// launchd/cron trigger: POST the loopback-only run route so the work runs in the app's TS
// (scan.mdx §3.1 — deliberately Node, never raw curl). Args: <worker> <apiPort>.
const worker = process.argv[2] || "sync";
const port = process.argv[3] || process.env.LFB_API_PORT || "8787";
const url = `http://127.0.0.1:${port}/api/internal/run/${worker}`;

const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), 60_000);
try {
  const res = await fetch(url, { method: "POST", signal: ctrl.signal });
  if (!res.ok) {
    process.stderr.write(`run-worker ${worker}: HTTP ${res.status}\n`);
    process.exit(1);
  }
  process.stdout.write(`run-worker ${worker}: ok\n`);
} catch (e) {
  process.stderr.write(`run-worker ${worker}: ${e.message}\n`);
  process.exit(1);
} finally {
  clearTimeout(t);
}
