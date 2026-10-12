#!/usr/bin/env node
// The background launcher: run `pnpm dev` with its whole output streamed through the rotating sink.
//
// WHY A SUPERVISOR PROCESS. The justfile used to do this in one bash line:
//
//     nohup pnpm dev > >(exec node log_rotate_pipe.mjs "$log") 2>&1 & echo $! > pidfile
//
// `> >(…)` is bash process substitution — it does not exist in cmd.exe or PowerShell, and `nohup` is not
// on Windows either. This file is that line, as a program: it owns the pipe from the dev tree into the
// sink, so the shell that started it can return immediately, and it is what the pidfile points at.
//
// It is spawned DETACHED by `dev.mjs run` and then unref'd, so it outlives the `just run` invocation on
// every platform (POSIX: its own session via `detached`; Windows: its own process group).
import fs from "node:fs";
import { spawn } from "node:child_process";
import { codeDir, ensureDir, launcherLog, logPipe, pidFile, stateDir } from "./paths.mjs";
import { groupAlive, isWindows, spawnTool, terminate, terminateGroup } from "./proc.mjs";

ensureDir(stateDir());

const logFile = launcherLog();

// The sink is plain `node <script>` — never a shell wrapper — so it is one process on every platform and
// `sink.stdin` is a pipe we can hand both of the app's streams to.
const sink = spawn(process.execPath, [logPipe, logFile], {
  stdio: ["pipe", "ignore", "ignore"],
  windowsHide: true,
});
sink.on("error", () => {}); // logging must never take the app down with it

const say = (level, msg) => {
  // The launcher's own lines carry the logger's shape so `launcher.log` stays greppable alongside the
  // app's output (the run-worker.mjs LOG FORMAT CONTRACT, same reasoning).
  try {
    sink.stdin.write(`[${new Date().toISOString()}] [${level}] [launcher] ${msg}\n`);
  } catch {
    /* the sink died — nothing we can do from here, and it must not be fatal */
  }
};

const app = spawnTool("pnpm", ["dev"], {
  cwd: codeDir,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  // POSIX: its own process group, so a stray Ctrl-C in the terminal that ran `just run` cannot reach the
  // dev tree. Windows already gets that from the detached spawn of this file.
  detached: !isWindows,
});

app.stdout?.pipe(sink.stdin, { end: false });
app.stderr?.pipe(sink.stdin, { end: false });

say("INFO", `starting pnpm dev in ${codeDir} (launcher pid ${process.pid}, app pid ${app.pid})`);

// The pidfile records BOTH: the launcher is what the caller started, the app is the pnpm tree that holds
// the ports. JSON rather than the bare number the bash launcher wrote, because one number can no longer
// answer both questions — `dev.mjs stop` reads either shape.
try {
  fs.writeFileSync(
    pidFile(),
    JSON.stringify({ launcher: process.pid, app: app.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );
} catch (e) {
  say("WARN", `could not write the pidfile ${pidFile()}: ${e?.message || e}`);
}

app.on("error", (e) => {
  say("ERROR", `pnpm dev could not be started: ${e?.message || e}`);
  finish(1);
});

app.on("exit", (code, signal) => {
  say("INFO", `pnpm dev exited (code=${code ?? "null"} signal=${signal ?? "none"})`);
  reapThenFinish(typeof code === "number" ? code : 1);
});

// A signal aimed at the launcher is aimed at the app — take the tree down rather than orphan it.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => reapThenFinish(0));
}

/**
 * Do not exit while anything we started is still running.
 *
 * This used to SIGTERM `app.pid` alone and exit 1.5s later. `app.pid` is the top `pnpm`; the processes
 * that matter are three rungs below it, and a signal to pnpm is not a signal to them. Whatever outlived
 * that — the `tsx watch` parent, an ffmpeg or transcription child of the backend — was left parented to
 * init with nothing recording its pid. A surviving watcher respawns the backend on the next source edit,
 * and this repo is auto-committed continuously, so every restart could leave one more behind.
 *
 * The dev tree is its own process GROUP (spawned `detached` above), so the whole of it can be signalled
 * at once: TERM the group, wait for it to empty, KILL what is left. The grace is long enough for the
 * backend's own SIGTERM handler to write the ledger's SHUTDOWN marker (main.ts `shutdown`). The same sweep
 * runs when `pnpm dev` exits on its own, so "the launcher is gone" always means "the tree is gone".
 */
const REAP_GRACE_MS = 5000;
let reaping = false;
function reapThenFinish(code) {
  if (reaping) return;
  reaping = true;
  const pgid = app.pid;
  if (!pgid || !groupAlive(pgid)) {
    // Windows (no groups): taskkill /T walks the tree. POSIX with an empty group: nothing to do.
    if (isWindows && pgid) terminate([pgid], { hard: false });
    return finish(code);
  }
  terminateGroup(pgid, { hard: false });
  const deadline = Date.now() + REAP_GRACE_MS;
  const timer = setInterval(() => {
    const alive = groupAlive(pgid);
    if (alive && Date.now() < deadline) return;
    clearInterval(timer);
    if (alive) {
      say("WARN", `dev tree (group ${pgid}) ignored SIGTERM for ${REAP_GRACE_MS}ms — sending SIGKILL`);
      terminateGroup(pgid, { hard: true });
    }
    finish(code);
  }, 100);
}

function finish(code) {
  // Set the code BEFORE the timer: the timer is unref'd, so once the sink's pipe closes nothing holds the
  // event loop open and node can exit on its own first — with 0, whatever the app's real exit code was.
  process.exitCode = code;
  try {
    sink.stdin.end();
  } catch {
    /* already closed */
  }
  // Give the sink a moment to flush the last chunk before the pipe goes away with us.
  setTimeout(() => process.exit(code), 200).unref?.();
}
