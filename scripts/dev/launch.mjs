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
import { isWindows, spawnTool, terminate } from "./proc.mjs";

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
  finish(typeof code === "number" ? code : 1);
});

// A signal aimed at the launcher is aimed at the app — take the tree down rather than orphan it.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (app.pid) terminate([app.pid], { hard: false });
    setTimeout(() => finish(0), 1500).unref?.();
  });
}

function finish(code) {
  try {
    sink.stdin.end();
  } catch {
    /* already closed */
  }
  // Give the sink a moment to flush the last chunk before the pipe goes away with us.
  setTimeout(() => process.exit(code), 200).unref?.();
}
