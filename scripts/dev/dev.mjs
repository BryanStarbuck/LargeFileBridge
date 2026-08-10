#!/usr/bin/env node
// The task runner's hands. Everything `just` used to do in bash lives here, so the justfile is the same
// file on macOS, Linux and Windows and each recipe is one portable line.
//
// WHY. The justfile's recipes were bash scripts built out of `lsof`, `pgrep`, `launchctl`, `plutil`,
// `nohup`, process substitution and `tail -f`. Not one of those runs on Windows, and `lsof`/`launchctl`
// are absent from a stock Linux too — so `just run`, `just stop`, `just status`, `just logs` and
// `just boot` were macOS-only recipes that FAILED QUIETLY elsewhere (a stop that reaps nothing looks
// exactly like a stop that had nothing to reap). Node is already a hard dependency of this app and
// behaves the same on all three, so the logic moved here and the platform differences are confined to
// scripts/dev/proc.mjs and scripts/dev/boot.mjs.
//
// Usage: node scripts/dev/dev.mjs <command>
//   check-tools | check-auth-lib | install [--cli] | seed-env | run | boot-run | stop | status
//   logs [--all|--txn] | clean | boot <on|off|status> | paths
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  appLog,
  authLib,
  authRepo,
  backendDir,
  bePort,
  bootErrLog,
  bootOutLog,
  cliDir,
  codeDir,
  devDir,
  ensureDir,
  errorLog,
  launcherLog,
  pidFile,
  portFile,
  recordedWebPort,
  repoRoot,
  stateDir,
  txnLog,
  workerLabels,
} from "./paths.mjs";
import { describeProblems, ensureInstalled, moduleDirs, treeProblems } from "./deps.mjs";
import {
  freePort,
  haveTool,
  isAlive,
  isListening,
  isWindows,
  pidsMatchingAll,
  pidsOnPort,
  sleep,
  terminate,
  waitUntil,
} from "./proc.mjs";
import { bootOff, bootOn, bootState, bootStatusLine, bootWhere } from "./boot.mjs";

// Piping into `head` (`just status | head -4`, `just logs | grep …`) closes stdout early — that is a
// normal way to consume this output, not a fault. Exit clean on EPIPE instead of crashing with a stack
// trace, exactly as the CLI does (cli/code/src/main.ts).
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e?.code === "EPIPE") process.exit(0);
    throw e;
  });
}

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

// The matchers that identify OUR dev tree, and nothing else on the machine — the pnpm orchestrator, the
// Vite dev server, the backend `tsx watch` parent and its heap-ceiling wrapper. Each is a set of
// substrings that must ALL appear in one command line (proc.mjs `pidsMatchingAll`).
// `src/main.ts` — never `src/cli.ts` — is what keeps the background pin/scan/device worker out of it.
const DEV_TREE = [
  ["@lfb/", "--parallel dev"],
  [codeDir, "packages/frontend"],
  [codeDir, "src/main.ts"],
  // The heap-ceiling wrapper the backend's `dev`/`start` scripts go through. Its own argv is relative
  // (`node ../../../scripts/node-heap-run.mjs tsx watch src/main.ts`), so the code-path matcher above
  // cannot see it; our script's name plus `src/main.ts` is what identifies it.
  ["node-heap-run.mjs", "src/main.ts"],
];

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "check-tools":
      return checkTools();
    case "check-auth-lib":
      return checkAuthLib();
    case "install":
      return cmdInstall(rest);
    case "seed-env":
      return seedEnv();
    case "run":
      return cmdRun();
    case "boot-run":
      return cmdBootRun();
    case "stop":
      return cmdStop();
    case "status":
      return cmdStatus();
    case "logs":
      return cmdLogs(rest);
    case "clean":
      return cmdClean();
    case "boot":
      return cmdBoot(rest[0] || "status");
    case "paths":
      return cmdPaths();
    default:
      err(`dev.mjs: unknown command "${cmd ?? ""}"`);
      err(
        "Usage: node scripts/dev/dev.mjs <check-tools|check-auth-lib|install|seed-env|run|stop|status|logs|clean|boot|paths>",
      );
      process.exitCode = 2;
  }
}

// ── preflight ───────────────────────────────────────────────────────────────────────────────────────

/** Fail fast (with a per-platform fix hint) if a required tool is missing. */
function checkTools() {
  const hint = (tool) => {
    if (process.platform === "darwin") return `brew install ${tool}`;
    if (isWindows) return `winget install ${tool === "pnpm" ? "pnpm.pnpm" : "OpenJS.NodeJS"}`;
    return `your package manager, e.g. sudo pacman -S ${tool} / sudo apt install ${tool}`;
  };
  let ok = true;
  for (const tool of ["node", "pnpm"]) {
    if (!haveTool(tool)) {
      err(`✗ missing '${tool}' — install with: ${hint(tool)}`);
      ok = false;
    }
  }
  if (!ok) {
    err("Fix the above and re-run.");
    process.exitCode = 1;
  }
}

/** Where the auth lib's own pnpm workspace lives — the root its `link:` targets are packages of. */
const authLibCode = path.join(authLib, "code");

/**
 * Is OpenAuthFederated a REAL checkout — as in, are its two packages actually packages?
 *
 * The test is the MANIFEST, not the directory. `fs.existsSync(<dir>)` was the whole of this check until
 * 2026-08-05, and an EMPTY `auth-backend/` passes it: the directory a `link:` points at survives its
 * contents being removed, so a wiped checkout reads as present and `just setup` says "Setup complete."
 * over a link that resolves to nothing. Reading `package.json` tells those two states apart.
 */
function authLibPackages() {
  return ["auth-backend", "auth-react"].map((name) => ({
    name,
    dir: path.join(authLibCode, "packages", name),
    manifest: fs.existsSync(path.join(authLibCode, "packages", name, "package.json")),
  }));
}

/** Both packages consume OpenAuthFederated via `link:` deps; `pnpm install` dies outright if it is absent. */
function checkAuthLib() {
  const packages = authLibPackages();
  if (packages.every((p) => p.manifest)) return;
  const cloned = fs.existsSync(authLibCode);
  err("");
  err(`✗ OpenAuthFederated is ${cloned ? "checked out but INCOMPLETE" : "not available locally"}.`);
  err("");
  err("  This app's authentication depends on it via link: deps:");
  err("      @auth/backend → code/packages/auth-backend");
  err("      @auth/react   → code/packages/auth-react");
  err(`  Expected location: ${authLib}`);
  err("");
  if (cloned) {
    err("  No package.json in:");
    for (const p of packages.filter((x) => !x.manifest)) err(`      ${p.dir}`);
    err("");
    err("  Its working tree is missing files. Restore them there, then re-run:");
    err("");
    err(`      git -C "${authLib}" status`);
    err(`      git -C "${authLib}" checkout -- code/packages`);
  } else {
    err("  Clone it so the link: paths resolve, then re-run:");
    err("");
    err(`      git clone ${authRepo} "${authLib}"`);
  }
  err("");
  process.exitCode = 1;
}

/**
 * Install and verify the auth lib's OWN dependency tree — the one `pnpm install` here never touches.
 *
 * A `link:` dependency is a link to a directory, not a copy of a package: nothing about installing THIS
 * workspace installs THAT one. Node resolves `jose` from
 * `OpenAuthFederated/code/packages/auth-backend/node_modules/`, so when the auth lib's own tree is missing
 * the backend throws `Cannot find module 'jose'` at its first import — inside the detached launcher, before
 * the logger exists, which is why log.log is empty in that state and only the launcher log has it.
 *
 * NOT fatal, deliberately, and the code says so as loudly as this comment: a sibling repo is not ours to
 * guarantee, `just run` still has to start for anyone working on the frontend, and the app's own failure is
 * now reported precisely when it happens (`reportDeadTree`). A MISSING auth lib is still a hard stop —
 * that is `_check-auth-lib`, above, which runs before this.
 */
async function ensureAuthLib() {
  if (!authLibPackages().every((p) => p.manifest)) {
    checkAuthLib();
    return 1;
  }
  const code = await ensureInstalled(authLibCode, { label: "auth lib (OpenAuthFederated/code)" });
  if (code !== 0) {
    err("");
    err("  The web app's @auth/backend / @auth/react link: deps resolve THEIR imports from that tree, so");
    err("  the backend will fail at its first import (Cannot find module 'jose') and never listen.");
    err("  Starting anyway — the frontend works without it.");
    err("");
  }
  return code;
}

/**
 * Install dependencies AND prove the tree they produced actually resolves (deps.mjs `ensureInstalled`).
 *
 * `pnpm install` answering "Already up to date" is a statement about the lockfile, not about node_modules:
 * on 2026-08-05 it said exactly that on Windows over a tree whose every package link dangled, and the only
 * thing that noticed was `pnpm dev`, half a minute later, inside a detached launcher. So the install is no
 * longer the last word here — the verification is.
 *
 * The reinstall step removes node_modules, so the app is stopped first: on Windows a file held by the
 * running dev tree cannot be replaced, and a half-removed tree is worse than the one we started with.
 */
async function cmdInstall(args) {
  const cli = args.includes("--cli");
  const root = cli ? path.join(cliDir, "code") : codeDir;
  // The auth lib first, and only for the web app: our `link:` deps point INTO it, so a tree that does not
  // resolve there is a backend that does not boot here. Loud, never fatal — see ensureAuthLib.
  if (!cli) await ensureAuthLib();
  const code = await ensureInstalled(root, {
    label: cli ? "CLI (cli/code)" : "web app (code)",
    beforeReinstall: cli ? undefined : () => cmdStop({ quiet: true }),
  });
  if (code !== 0) process.exitCode = code;
}

/** Seed the backend .env from .env.example on first setup. (`test -f … || cp …`, portably.) */
function seedEnv() {
  const env = path.join(backendDir, ".env");
  const example = path.join(backendDir, ".env.example");
  if (fs.existsSync(env) || !fs.existsSync(example)) return;
  fs.copyFileSync(example, env);
  out(`Seeded ${env} from .env.example`);
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Start the backend + web app in the background.
 *
 * Stops OUR previous instance first — that is what makes `just run` a true restart — and then hands off
 * to the detached launcher (launch.mjs), which owns the pipe into the rotating log sink. Vite resolves
 * the web port on boot and publishes it to the port file, so we do NOT blanket-kill the web port here:
 * a FOREIGN process on :2222 is stepped around, never killed (code_plan.mdx §2).
 */
async function cmdRun() {
  await cmdStop({ quiet: true });
  ensureDir(stateDir());
  try {
    fs.rmSync(portFile(), { force: true });
  } catch {
    /* nothing recorded yet */
  }

  const child = spawn(process.execPath, [path.join(devDir, "launch.mjs")], {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  // The launcher lives as long as `pnpm dev` does, so its EXIT is the dev tree's death certificate. Watch
  // for it: without this, a tree that died in the first second still cost the caller the full 30s timeout
  // and then reported "Timed out waiting for ports" — a waiting-for-a-slow-boot message for a process
  // that was already gone, which sends you looking at ports when the answer is in the log.
  let launcherExit = null;
  child.on("exit", (code) => {
    launcherExit = typeof code === "number" ? code : 1;
  });
  child.on("error", (e) => {
    err(`could not start the launcher: ${e?.message || e}`);
    launcherExit = 127;
  });
  child.unref();

  out(`Starting… (logs: ${launcherLog()}, rotating via scripts/log_rotate_pipe.mjs)`);

  const api = bePort();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const web = readPortFile();
    if (web && (await isListening(web)) && (await isListening(api))) {
      out(`Up: http://localhost:${web}  (API :${api})`);
      return;
    }
    if (launcherExit !== null) return reportDeadTree(launcherExit);
    await sleep(500);
  }
  err(`Timed out waiting for ports — see ${launcherLog()}`);
  err(tailFile(launcherLog(), 30));
  process.exitCode = 1;
}

/**
 * The dev tree exited before the app came up. Print what it said, and — because a broken node_modules is
 * by far the most common reason for an instant exit, and its stack trace names one missing file rather
 * than the state that produced it — check the dependency tree and name what does not resolve.
 */
async function reportDeadTree(code) {
  // The launcher writes its last line and then gives the sink 200ms to flush before it exits. Let that
  // land, or the tail we print here stops one line short of the reason.
  await sleep(400);
  err("");
  err(`✗ The dev tree exited (code=${code}) before the app came up — it is NOT running.`);
  err(`  ${launcherLog()}:`);
  err(tailFile(launcherLog(), 30));

  const problems = treeProblems(codeDir);
  if (problems.length) {
    err("");
    err("  The installed dependency tree is broken — that is very likely why:");
    for (const line of describeProblems(problems, codeDir).slice(0, 12)) err(line);
    if (problems.length > 12) err(`    …and ${problems.length - 12} more`);
    err("");
    err("  Fix it with:  just clean     then     just run");
  }
  err("");
  process.exitCode = 1;
}

/**
 * What the login-startup job runs (`just boot on`). Same start, plus the two things a login has to do for
 * itself: refresh dependencies, and roll the boot logs.
 *
 * The rotation is HERE, at the moment the file is about to be reopened, because launchd's
 * `StandardOutPath`, systemd's `append:` and the .vbs `>>` all write to a descriptor we do not own — the
 * rotating sink cannot reach them. Same boundary, same 5 MiB × 5 policy, as the IPFS daemon logs
 * (logging.ts `rotateIfOversized`).
 */
async function cmdBootRun() {
  for (const file of [bootOutLog(), bootErrLog()]) rotateIfOversized(file);
  // The same verified install `just setup` does — a login job is the LEAST watched place for a tree that
  // says it is installed and is not (deps.mjs). It still starts either way: a repair that could not run
  // unattended must not be the reason the app is missing at the desk in the morning.
  await ensureAuthLib();
  const code = await ensureInstalled(codeDir, { label: "web app (code)" });
  if (code !== 0) err(`boot-run: install exited ${code} — starting anyway with whatever is installed.`);
  await cmdRun();
}

// ── stop ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Stop OUR app only — BOTH the web app (Vite) and the backend dev tree — and do not return until the
 * ports are actually free.
 *
 * PHASE 0 is the load-bearing one, and it is why this is not simply "kill the tree". The backend writes
 * the ledger's SHUTDOWN marker from its own signal handler, and a BOOT with no SHUTDOWN above it is what
 * the ledger DEFINES as a crash (crash_recovery.mdx §5.1). Reap the backend by a route that runs none of
 * its JavaScript and every ordinary restart is reported to the user as a crash — which is precisely the
 * "8× ended ABNORMALLY in two days" report. So the backend is stopped FIRST, ALONE, and waited for:
 *
 *   1. ASK IT TO STOP — POST the loopback-only /api/internal/shutdown route. This is the only graceful
 *      stop that exists on Windows: Windows has no SIGTERM, `taskkill` without /F posts WM_CLOSE, and a
 *      console process such as node never sees it. Asking over the API works identically everywhere.
 *   2. On POSIX, if the route did not answer (an older build, a wedged event loop), fall back to the
 *      SIGTERM-by-port-and-name that was here before.
 * Nothing is escalated in phase 0 — every hard kill still happens below, so a wedged process is no slower
 * to reap than before; it just gets a real chance to say goodbye first.
 */
async function cmdStop({ quiet = false } = {}) {
  const api = bePort();
  const web = recordedWebPort();

  if (await isListening(api)) {
    const asked = await requestShutdown(api);
    const freed = await waitUntil(async () => !(await isListening(api)), { timeoutMs: 6000, everyMs: 150 });
    if (!freed && !isWindows) {
      terminate([...pidsOnPort(api), ...pidsMatchingAll([[codeDir, "src/main.ts"]])], { hard: false });
      await waitUntil(async () => !(await isListening(api)), { timeoutMs: 6000, everyMs: 150 });
    }
    if (!asked && !quiet) {
      // Worth saying: it means the marker probably was not written, so the next boot may read as a crash.
      err("Note: the backend did not answer /api/internal/shutdown — it may be recorded as an unclean stop.");
    }
  }

  // PHASE 1 — the rest of the tree, by name. `pnpm --parallel dev` kills its sibling script as soon as one
  // exits, and `tsx watch` respawns its child on any source edit (this repo is continuously auto-committed,
  // so that race is real), which is why this is TERM, TERM, KILL rather than one shot.
  for (const step of [{ hard: false }, { hard: false }, { hard: true }]) {
    const pids = pidsMatchingAll(DEV_TREE);
    if (!pids.length) break;
    terminate(pids, step);
    await sleep(600);
  }

  // PHASE 2 — belt and suspenders: free the ports, catching a child that reparented mid-restart.
  //
  // The API port is ours by convention (nothing else on the machine is asked to run on it). The WEB port
  // is not: `recordedWebPort()` falls back to the :2222 DEFAULT when nothing has been recorded, and :2222
  // may well belong to a stranger — the very case the collision policy exists to respect (code_plan.mdx
  // §2). So the web port is only freed once it has identified itself as ours by the same stable marker
  // web-port.mjs uses. Anything already killed in phase 1 makes this a no-op.
  await freePort(api);
  if (await isListening(web)) {
    if (await isOurWebApp(web)) await freePort(web);
    else if (!quiet) err(`Left :${web} alone — that is not our web app (no x-app marker at "/").`);
  }

  // PHASE 3 — whatever the launcher recorded, in case it outlived its child.
  const recorded = readPidFile();
  if (recorded.length) {
    terminate(recorded, { hard: false });
    await sleep(300);
    terminate(recorded.filter(isAlive), { hard: true });
  }
  try {
    fs.rmSync(pidFile(), { force: true });
  } catch {
    /* nothing to remove */
  }
  if (!quiet) out("Stopped.");
}

/**
 * Is the web app on this port OURS? The same question, answered the same way, as
 * packages/frontend/scripts/web-port.mjs `isOurApp()`: the stable
 * `<meta name="x-app" content="large-file-bridge">` marker that index.html serves at "/". It is what
 * keeps `stop` from killing a stranger that happens to hold :2222.
 */
async function isOurWebApp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    return (await res.text()).includes('content="large-file-bridge"');
  } catch {
    return false; // unreachable or wedged — treat as not ours and leave it alone
  }
}

/** Ask the app to shut itself down, so it writes its own SHUTDOWN marker. False if it did not answer. */
async function requestShutdown(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false; // not listening, no such route (an older build), or it died mid-answer — all the same here
  }
}

// ── status ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Report the web app, the backend (health-checked, not merely listening) and the background agents.
 *
 * The BACKEND is what this exists to assert. On 2026-07-15 it OOMed and stayed dead ~6 hours while Vite
 * served :2222 at HTTP 200 the whole time — `tsx watch` restarts on file change, never on crash. FRONTEND
 * UP ≠ APP UP, so a dead backend is a loud, unmissable failure here and exits non-zero for scripts too.
 */
async function cmdStatus() {
  const api = bePort();
  const web = recordedWebPort();

  out((await isListening(web)) ? `web app  :${web} UP` : `web app  :${web} down`);

  let backendUp = false;
  if (await isListening(api)) {
    const health = await healthy(api);
    if (health === "ok") {
      out(`backend  :${api} UP (health OK)`);
      backendUp = true;
    } else if (health === "slow") {
      out(`backend  :${api} UP, but SLOW — health took seconds to answer.`);
      out("           A boot scan/pin pass holds the event loop; it clears when the pass ends.");
      backendUp = true;
    } else {
      out(`backend  :${api} LISTENING but /api/health never answered in 30s — the process is wedged.`);
    }
  }

  out(`agent scan  (4h)  ${workerStatus(workerLabels.scan)}`);
  out(`agent pin   (15m) ${workerStatus(workerLabels.pin)}`);
  out(`agent device(10m) ${workerStatus(workerLabels.device)}`);
  out(bootStatusLine());

  if (!backendUp) {
    // Plain rules, not a boxed frame: ports vary in width and a frame padded around them drifts out of
    // alignment. The message has to survive being read at 4am.
    out("");
    out("  ============================================================================");
    out(`   ***  BACKEND :${api} IS DOWN — THE APP IS NOT RUNNING.  ***`);
    out(`   A live web app on :${web} does NOT mean the app works. Vite serves pages fine`);
    out("   with a dead backend — it did exactly that for 6h on 2026-07-15 after an OOM,");
    out("   because `tsx watch` restarts on file change and NEVER on crash.");
    out("  ============================================================================");
    out("");
    // Name the cause if it is the known one. A V8 OOM abort appears ONLY in the launcher log — it runs no
    // JS, so log.log / error.err are structurally silent about it (memory.mdx P-32).
    const oom = grepTail(launcherLog(), /FATAL ERROR|JavaScript heap out of memory/, 3);
    if (oom.length) {
      out(`  Cause found in ${launcherLog()} — the backend ran OUT OF HEAP:`);
      for (const line of oom) out(`    ${line}`);
      const pressure = [
        ...grepTail(errorLog(), /HEAP PRESSURE|heap_pressure|\[HEARTBEAT\]/, 3),
        ...grepTail(txnLog(), /HEAP PRESSURE|heap_pressure|\[HEARTBEAT\]/, 3),
      ].slice(-3);
      if (pressure.length) {
        out("");
        out("  Heap pressure before the abort (transactions.log / error.err):");
        for (const line of pressure) out(`    ${line}`);
      }
      out("");
    }
    out("  Next:  just run          (start it)");
    out("         just txlog        (the work ledger — what it was doing when it stopped)");
    out("         just logs         (the launcher catch-all — whether the PROCESS died)");
    out("");
    process.exitCode = 1;
  }
}

/**
 * Did /api/health answer? `"ok"` | `"slow"` | `"dead"`.
 *
 * ONE 3-second probe was not enough to tell a wedged process from a BUSY one, and getting that wrong is
 * expensive in both directions. Measured 2026-08-10, seconds after `just run`: the boot pin pass holds the
 * event loop for stretches longer than 3s, so health alternated 200 / timeout — and status printed
 * "***  BACKEND IS DOWN — THE APP IS NOT RUNNING  ***" about a backend that was working, then exited
 * non-zero. A user told the app is dead restarts it, which throws away the boot pass that was running and
 * buys the same message again.
 *
 * So probe repeatedly across ~30s. ANY 200 in that window means the process is alive and running JS —
 * report it as UP, and say it was slow, which is true and is the actionable part. Only a window with no
 * answer at all is the dead/wedged case the loud banner exists for.
 */
async function healthy(port, { attempts = 6, perTryMs = 5000 } = {}) {
  let answered = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(perTryMs) });
      if (res.ok) return i === 0 ? "ok" : "slow";
      answered = true; // it replied, just not 200 — still running JS, so not wedged
    } catch {
      /* timeout or refused — try again */
    }
  }
  return answered ? "slow" : "dead";
}

/**
 * Whether the OS has this background worker, asked WITHOUT the backend — the artifact each installer
 * treats as "installed" (modules/schedule/os/): a plist, a .vbs launcher, a .timer unit.
 */
function workerStatus(label) {
  // `os.homedir()`, never `process.env.HOME`: HOME is a POSIX variable that Windows does not set, and
  // reading it there yields paths rooted at "" (shared/home-path.ts exists for exactly this class of bug).
  const artifact = isWindows
    ? path.join(stateDir(), "workers", `${label}.vbs`)
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`)
      : path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
          "systemd",
          "user",
          `${label}.timer`,
        );
  return fs.existsSync(artifact) ? "INSTALLED" : "not installed";
}

// ── logs ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `tail -f`, portably — Windows has no tail, and PowerShell's `Get-Content -Wait` cannot follow several
 * files at once. Prints the last 30 lines of each file and then follows appends, reopening a file from
 * the top when it SHRINKS, which is what a 5 MiB rotation looks like from out here.
 */
async function cmdLogs(args) {
  const files = args.includes("--all")
    ? [launcherLog(), appLog(), errorLog(), txnLog()]
    : args.includes("--txn")
      ? [txnLog()]
      : [launcherLog()];

  const multi = files.length > 1;
  const offsets = new Map();
  for (const file of files) {
    if (multi) out(`==> ${file} <==`);
    out(tailFile(file, 30));
    offsets.set(file, sizeOf(file));
  }
  err("(following — Ctrl-C to stop)");

  for (;;) {
    for (const file of files) {
      const size = sizeOf(file);
      const from = offsets.get(file) ?? 0;
      if (size < from) {
        offsets.set(file, 0); // rotated out from under us — follow the new file from its start
        continue;
      }
      if (size === from) continue;
      const chunk = readRange(file, from, size);
      offsets.set(file, size);
      if (chunk) process.stdout.write(multi ? `==> ${file} <==\n${chunk}` : chunk);
    }
    await sleep(400);
  }
}

// ── clean ───────────────────────────────────────────────────────────────────────────────────────────

/** Remove installed deps and background run state. Leaves the app's own log.log / error.err intact. */
async function cmdClean() {
  await cmdStop({ quiet: true });
  for (const file of [launcherLog(), pidFile(), portFile()]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  }
  for (const dir of moduleDirs(codeDir)) {
    try {
      // maxRetries for Windows, where a file the dev tree only just released answers EBUSY once.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      err(`could not remove ${dir}: ${e?.message || e}`);
    }
  }
  out("Cleaned. Run 'just setup' to reinstall.");
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────────────

function cmdBoot(mode) {
  switch (mode) {
    case "on": {
      let where;
      try {
        where = bootOn();
      } catch (e) {
        // A scheduler that refused the registration is a FAILURE, and it must read as one — the whole
        // point of this recipe is that the app starts by itself, and "✓ enabled" over a scheduler that
        // never accepted the job is the silent nothing the app's own installers are hardened against.
        err("");
        err(`✗ Start-at-reboot could NOT be enabled: ${e?.message || e}`);
        err("");
        process.exitCode = 1;
        return;
      }
      out("");
      out("✓ Start-at-reboot ENABLED for the Large File Bridge web app.");
      out("");
      out(`  Registered → ${where}`);
      out(`  Starts     → node scripts/dev/dev.mjs boot-run   (pnpm install, then the web app + API :${bePort()})`);
      out(`  Logs       → ${bootOutLog()}`);
      out(`               ${bootErrLog()}`);
      out("");
      out("  Turn it back off with: just boot off");
      out("");
      return;
    }
    case "off":
      bootOff();
      out("");
      out("✓ Start-at-reboot DISABLED. The web app will NOT start at reboot.");
      out("  (Anything already running is untouched — stop it with: just stop)");
      out("");
      return;
    case "status":
      out(`  ${bootStatusLine()}`);
      if (bootState() !== "off") out(`  registered at: ${bootWhere()}`);
      return;
    default:
      err("Usage: just boot [on|off|status]");
      process.exitCode = 1;
  }
}

// ── paths ───────────────────────────────────────────────────────────────────────────────────────────

/** Where everything actually resolved on THIS machine — the first thing to check when a path is wrong. */
function cmdPaths() {
  const rows = [
    ["platform", `${process.platform} (node ${process.version})`],
    ["repo", repoRoot],
    ["state root", stateDir()],
    ["launcher log", launcherLog()],
    ["app log", appLog()],
    ["fault trail", errorLog()],
    ["work ledger", txnLog()],
    ["port file", portFile()],
    ["pid file", pidFile()],
    ["api port", String(bePort())],
    ["web port", `${recordedWebPort()} (last recorded)`],
    ["auth library", authLib],
  ];
  for (const [k, v] of rows) out(`${k.padEnd(14)} ${v}`);
}

// ── small file helpers ──────────────────────────────────────────────────────────────────────────────

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readRange(file, from, to) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(to - from);
    const read = fs.readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** The last N lines of a file, without reading a 5 MiB log into memory to get them. */
function tailFile(file, lines) {
  const size = sizeOf(file);
  if (!size) return `(${file} is empty or absent)`;
  const from = Math.max(0, size - 64 * 1024);
  const text = readRange(file, from, size);
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

function grepTail(file, pattern, limit) {
  return tailFile(file, 4000)
    .split("\n")
    .filter((line) => pattern.test(line))
    .slice(-limit);
}

/** Roll a log written by a descriptor we don't own, at the moment before it is reopened. */
function rotateIfOversized(file) {
  const max = Number(process.env.LFB_LOG_MAX_BYTES) || 5 * 1024 * 1024;
  const generations = Number(process.env.LFB_LOG_GENERATIONS) || 5;
  if (sizeOf(file) < max) return;
  try {
    fs.rmSync(`${file}.${generations}`, { force: true });
    for (let i = generations - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        /* generation absent */
      }
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // best-effort: a log we could not roll is still a log we must not fail the boot over
  }
}

function readPortFile() {
  try {
    const p = Number(fs.readFileSync(portFile(), "utf8").trim());
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** The launcher + app pids. Accepts the bare number the old bash launcher wrote, as well as our JSON. */
function readPidFile() {
  let raw;
  try {
    raw = fs.readFileSync(pidFile(), "utf8").trim();
  } catch {
    return [];
  }
  if (/^\d+$/.test(raw)) return [Number(raw)];
  try {
    const { launcher, app } = JSON.parse(raw);
    return [launcher, app].filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

await main();
