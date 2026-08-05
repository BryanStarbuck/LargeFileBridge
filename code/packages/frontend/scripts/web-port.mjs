// Smart web-app port resolver (code_plan.mdx §2 — port collision policy).
//
// The web app that serves pages ALWAYS defaults to :2222. On boot we resolve it:
//   1. Port free            → take it.
//   2. Port held by OUR app  → it's a stale/duplicate LFB instance; kill it and take over :2222.
//   3. Port held by SOMEONE  → do NOT disturb a foreign process; increment (+1) until we find a
//      ELSE                    free-or-ours port, and report the chosen port to the user.
//
// "Our app" is identified by the stable <meta name="x-app" content="large-file-bridge"> marker
// (index.html) served at "/". The one thing it cannot do with Node's stdlib alone — ask the OS which
// process holds a port — comes from scripts/dev/proc.mjs, which answers it on all three platforms.

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { pidsOnPort, terminate } from "../../../../scripts/dev/proc.mjs";

export const DEFAULT_WEB_PORT = 2222;
const HOST = "127.0.0.1";
const APP_MARKER = "large-file-bridge";
// Where we publish the resolved port so external tooling (the task runner, the CLI's `status`, health
// checks) can find it. `/tmp` is kept verbatim on macOS and Linux — deliberately not os.tmpdir(), which is
// /var/folders/… on macOS — so nothing about those machines changes. Windows has no /tmp: Node resolves it
// to `<drive>:\tmp`, a directory that does not exist, so the port would be published where no reader looks
// and `just run` would wait out its whole timeout on a live app. Kept in lockstep BY HAND with
// scripts/dev/paths.mjs `runtimeDir()`, which is the authority — this file is loaded by vite.config.ts and
// stays free of repo-relative behaviour it cannot see.
const RUNTIME_DIR = process.env.LFB_RUNTIME_DIR || (process.platform === "win32" ? os.tmpdir() : "/tmp");
export const PORT_FILE = path.join(RUNTIME_DIR, "lfb.web.port");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True if something is already bound to the port on our host. */
export function isPortInUse(port) {
  return new Promise((resolve) => {
    const srv = net
      .createServer()
      .once("error", (err) => resolve(err.code === "EADDRINUSE"))
      .once("listening", () => srv.close(() => resolve(false)))
      .listen(port, HOST);
  });
}

/** HTTP GET "/" and look for our ownership marker. Returns true only if it's clearly our web app. */
export function isOurApp(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port, path: "/", timeout: 1200 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 65536) req.destroy(); // cap; marker is in <head>
        });
        res.on("end", () => resolve(body.includes(`content="${APP_MARKER}"`)));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

export { pidsOnPort };

/**
 * Kill the PIDs holding a port and wait for it to free. Only ever called on a port we have already
 * PROVEN is ours (the app marker at "/"), never on a foreign process.
 *
 * `terminate` is the portable escalation: SIGTERM→SIGKILL on POSIX, `taskkill /T [/F]` on Windows, where
 * there is no SIGTERM to send and the tree matters (pnpm → tsx → node).
 */
async function freePort(port) {
  terminate(pidsOnPort(port), { hard: false });
  for (let i = 0; i < 20; i++) {
    if (!(await isPortInUse(port))) return true;
    await sleep(150);
  }
  // Still up — escalate.
  terminate(pidsOnPort(port), { hard: true });
  for (let i = 0; i < 10; i++) {
    if (!(await isPortInUse(port))) return true;
    await sleep(150);
  }
  return !(await isPortInUse(port));
}

/** Best-effort desired port: env WEB_PORT wins, else config.yaml server.frontend_port, else 2222. */
export function desiredWebPort() {
  const fromEnv = Number(process.env.WEB_PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const stateDir =
      process.env.LFB_STATE_DIR || path.join(os.homedir(), "T", "_large_files_bridge");
    const raw = fs.readFileSync(path.join(stateDir, "config.yaml"), "utf8");
    const p = YAML.parse(raw)?.server?.frontend_port;
    if (Number.isFinite(p) && p > 0) return Number(p);
  } catch {
    /* no config yet — fall through to default */
  }
  return DEFAULT_WEB_PORT;
}

/**
 * Resolve the web port per the collision policy above.
 * Returns { port, action: "free" | "took-over" | "moved", from }.
 */
export async function resolveWebPort(desired = desiredWebPort()) {
  const MAX_TRIES = 100;
  for (let port = desired; port < desired + MAX_TRIES; port++) {
    if (!(await isPortInUse(port))) {
      return finish({ port, action: port === desired ? "free" : "moved", from: desired });
    }
    if (await isOurApp(port)) {
      // A duplicate of ourselves — take it down and reclaim the port.
      if (await freePort(port)) {
        return finish({ port, action: port === desired ? "took-over" : "moved", from: desired });
      }
    }
    // Foreign process (or our own that refused to die) — leave it alone and try the next port.
  }
  throw new Error(`No free web port in ${desired}..${desired + MAX_TRIES - 1}`);
}

function finish(result) {
  try {
    fs.writeFileSync(PORT_FILE, String(result.port), "utf8");
  } catch (e) {
    // non-fatal: the port file is a convenience for external tooling — but log so a broken
    // handoff (justfile/health checks reading a stale port) is diagnosable.
    console.error(`[web-port] failed to write ${PORT_FILE}:`, e?.message || e);
  }
  return result;
}

/** Stop only OUR web app on a port — never a foreign process. Returns true if we freed it. */
export async function stopOurWebPort(port = desiredWebPort()) {
  if (!(await isPortInUse(port))) return false;
  if (!(await isOurApp(port))) return false; // someone else's — leave it alone
  return freePort(port);
}

// CLI:
//   node web-port.mjs            → resolve + print the chosen port (used by the justfile `run`)
//   node web-port.mjs stop [p]   → stop our web app on port p (default resolved/desired), foreign-safe
// `pathToFileURL`, not a `file://` template: a Windows argv[1] is `C:\…`, whose URL is `file:///C:/…`,
// so the naive comparison is false on every Windows run and the CLI block never executes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === "stop") {
    const p = Number(process.argv[3]) || readPortFile() || desiredWebPort();
    stopOurWebPort(p)
      .then((freed) => process.stdout.write(freed ? `stopped :${p}` : `nothing ours on :${p}`))
      .catch((e) => (process.stderr.write(String(e?.message || e)), process.exit(1)));
  } else {
    resolveWebPort()
      .then((r) => process.stdout.write(String(r.port)))
      .catch((e) => (process.stderr.write(String(e?.message || e)), process.exit(1)));
  }
}

function readPortFile() {
  try {
    const p = Number(fs.readFileSync(PORT_FILE, "utf8").trim());
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}
