// Ports and processes, answered the same way on macOS, Linux and Windows.
//
// WHY THIS FILE EXISTS. `just stop` and `just status` were built out of `lsof -ti`, `pgrep -f` and
// `kill -TERM`. None of the three exists on Windows, and `lsof` is not installed by default on most
// Linux distributions either — so the two recipes that decide whether the app is RUNNING answered
// "nothing is listening" on any machine that was not a Mac. That is the worst possible answer to get
// wrong: `just run` depends on `stop`, so a stop that silently reaps nothing turns every restart into a
// second instance fighting for the same port.
//
// Each primitive below picks the tool the platform actually ships:
//
// | question            | macOS        | Linux                     | Windows                        |
// | ------------------- | ------------ | ------------------------- | ------------------------------ |
// | is the port bound?  | a TCP connect attempt — no external tool anywhere                     |
// | who holds the port? | `lsof -ti`   | `lsof -ti` → `ss` → `fuser`| `netstat -ano`                 |
// | who is in our tree? | `pgrep -f`   | `pgrep -f`                | PowerShell `Win32_Process`     |
// | stop it             | SIGTERM/KILL | SIGTERM/KILL              | `taskkill /T [/F]`             |
import net from "node:net";
import { execFileSync, spawn, spawnSync } from "node:child_process";

export const isWindows = process.platform === "win32";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is anything accepting connections on this port?
 *
 * A CONNECT, not a bind probe: `net.createServer().listen()` reports EADDRINUSE, but it also SUCCEEDS on
 * a port some other process has bound to a different interface, and on Windows it can succeed against a
 * socket in TIME_WAIT. Connecting asks the only question that matters to a caller waiting for the app to
 * come up — is someone answering — and needs no external tool on any platform.
 */
export function isListening(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (answer) => {
      sock.destroy();
      resolve(answer);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, host);
  });
}

/** Poll `check()` until it is true or the budget runs out. Resolves to the final answer. */
export async function waitUntil(check, { timeoutMs = 6000, everyMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
}

/**
 * Spawn a developer tool (`pnpm`, `just`, `git`) portably.
 *
 * On Windows those are `.cmd` shims, and a `.cmd` cannot be handed to CreateProcess — Node has REFUSED to
 * run one without a shell since 20.12 (CVE-2024-27980). So the Windows branch goes through `cmd.exe`
 * with the one quoting form that survives paths containing spaces: `/s` makes cmd strip exactly the outer
 * quote pair and run the rest verbatim, which is why the whole command line is wrapped in quotes and
 * passed with `windowsVerbatimArguments` (Node's own escaping uses `\"`, which cmd does not understand).
 * The same idiom the worker shim uses — see modules/schedule/os/schtasks.ts `renderShim()`.
 */
export function spawnTool(name, args, opts = {}) {
  if (!isWindows) return spawn(name, args, opts);
  const line = [name, ...args].map(quoteForCmd).join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    windowsHide: true,
    windowsVerbatimArguments: true,
    ...opts,
  });
}

/** `spawnTool`, awaited. Resolves to the exit code (never rejects on a non-zero exit). */
export function runTool(name, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawnTool(name, args, { stdio: "inherit", ...opts });
    child.on("error", (e) => {
      process.stderr.write(`${name}: ${e?.message || e}\n`);
      resolve(127);
    });
    child.on("exit", (code, signal) => resolve(typeof code === "number" ? code : signal ? 1 : 0));
  });
}

/**
 * `runTool`, with stdout+stderr CAPTURED instead of inherited. Resolves to `{ code, output }`.
 * For steps whose chatter is worth showing only when they fail.
 */
export function runToolCaptured(name, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawnTool(name, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    child.on("error", (e) => resolve({ code: 127, output: `${output}${name}: ${e?.message || e}\n` }));
    child.on("exit", (code, signal) =>
      resolve({ code: typeof code === "number" ? code : signal ? 1 : 0, output }),
    );
  });
}

/** Is this tool callable at all? Used only for the "install X" hints. */
export function haveTool(name) {
  const probe = isWindows
    ? spawnSync("where", [name], { windowsHide: true, stdio: "ignore" })
    // `command -v` is a shell builtin, so it needs a shell — but pass the shell ONE argv we built
    // ourselves rather than `shell: true` (which concatenates argv unescaped and trips DEP0190).
    : spawnSync("/bin/sh", ["-c", `command -v ${shSingleQuote(name)}`], { stdio: "ignore" });
  return probe.status === 0;
}

/** POSIX single-quoting, so a tool name can never break out of the `sh -c` string. */
function shSingleQuote(arg) {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function quoteForCmd(arg) {
  return /[\s&|<>^()"]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Run a command and return its stdout. `null` means THE TOOL IS NOT THERE; `""` means it ran and had
 * nothing to say.
 *
 * The distinction is what makes the fallback chain in `pidsOnPort` correct rather than merely lucky:
 * `lsof` exits non-zero when NOTHING holds the port, and if that read as "no lsof here" we would go on to
 * ask `ss` and `fuser` the same question on every call — on a Mac, where neither answers, for every port
 * we ever look at.
 */
function tryRun(bin, args, { timeout = 20_000 } = {}) {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    if (e?.code === "ENOENT") return null; // not installed
    return e?.stdout ? String(e.stdout) : ""; // ran and failed — usually "no matches"
  }
}

const pidList = (text) =>
  [...new Set((text || "").split(/\s+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];

/** PIDs LISTENING on a TCP port. Empty when nothing holds it — or when no tool here can tell us. */
export function pidsOnPort(port) {
  if (isWindows) return windowsPidsOnPort(port);
  // lsof first (the only one of the three that is on a stock Mac), then the Linux fallbacks. `ss` is
  // part of iproute2 and present on essentially every modern Linux; `fuser` (psmisc) catches the rest.
  const lsof = tryRun("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
  if (lsof !== null) return pidList(lsof);
  const ss = tryRun("ss", ["-lptnH", `sport = :${port}`]);
  if (ss !== null) return pidList([...ss.matchAll(/pid=(\d+)/g)].map((m) => m[1]).join(" "));
  const fuser = tryRun("fuser", ["-n", "tcp", String(port)]);
  if (fuser !== null) return pidList(fuser);
  return [];
}

/**
 * `netstat -ano` is the Windows answer, and it is the right one: it is in System32 on every install,
 * needs no elevation, and prints the owning PID. We match the LOCAL address column on `:<port>` at its
 * end so `0.0.0.0:2222`, `127.0.0.1:2222` and `[::]:2222` all count, and only LISTENING rows — an
 * outbound connection to :8787 must never read as "the backend is up".
 */
function windowsPidsOnPort(port) {
  const out = tryRun("netstat", ["-ano", "-p", "tcp"]);
  if (out === null) return [];
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const [, local, , state, pid] = cols;
    if (!/^LISTEN/i.test(state)) continue;
    if (!local.endsWith(`:${port}`)) continue;
    pids.push(pid);
  }
  return pidList(pids.join(" "));
}

/**
 * Every process on the machine as `{ pid, cmd }`, with `cmd` normalised — lower-cased and slashed one way
 * — so a match can be written once and be true on all three platforms. A pnpm command line may carry
 * `code/packages/frontend` where `path.join` gave us `code\packages\frontend`, and those are one path.
 *
 * `ps -ww` rather than `pgrep -f`: `-ww` is what stops both implementations truncating a long argv (the
 * backend's `tsx watch` child has a ~1 KB command line, and a truncated one is exactly where the marker we
 * match on lives), and it lets the matching happen HERE, in one place, for POSIX and Windows alike.
 * Windows has no ps at all — and `wmic`, the usual substitute, was removed in Windows 11 24H2 — so that
 * branch asks CIM for the same two columns as JSON.
 */
export function listProcesses() {
  const norm = (s) => String(s || "").toLowerCase().replace(/\\/g, "/");
  if (!isWindows) {
    const out = tryRun("ps", ["-ww", "-eo", "pid=,args="]);
    if (!out) return [];
    return out
      .split(/\r?\n/)
      .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), cmd: norm(m[2]) }));
  }
  const out = tryRun("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
  ]);
  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((row) => row?.ProcessId && row?.CommandLine)
      .map((row) => ({ pid: Number(row.ProcessId), cmd: norm(row.CommandLine) }));
  } catch {
    return [];
  }
}

/**
 * PIDs whose command line contains EVERY substring of ANY one group (OR of ANDs).
 *
 * The AND is what keeps a matcher repo-scoped without a regex: "our `code/` path AND `src/main.ts`" hits
 * this repo's backend watcher and nothing else — not a sister app's, and not our own background worker,
 * which runs `src/cli.ts`. Never returns this process.
 */
export function pidsMatchingAll(groups) {
  const wanted = groups
    .map((g) => (Array.isArray(g) ? g : [g]).filter(Boolean).map((s) => String(s).toLowerCase().replace(/\\/g, "/")))
    .filter((g) => g.length);
  if (!wanted.length) return [];
  const out = [];
  for (const { pid, cmd } of listProcesses()) {
    if (pid === process.pid) continue;
    if (wanted.some((group) => group.every((needle) => cmd.includes(needle)))) out.push(pid);
  }
  return [...new Set(out)];
}

/** Is this PID still around? Signal 0 is a permission-check-only "does it exist" on POSIX and Windows alike. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // alive, just not ours to signal
  }
}

/**
 * Stop these PIDs and everything they spawned.
 *
 * `hard: false` is a REQUEST on POSIX (SIGTERM — the process runs its handler and writes its SHUTDOWN
 * marker) and, honestly, close to a no-op on Windows: Windows has no SIGTERM, `taskkill` without `/F`
 * posts WM_CLOSE, and a console process such as node never sees it. That is precisely why the graceful
 * stop goes through the app's own loopback shutdown route first (dev.mjs `stopBackendGracefully`) — by
 * the time we get here on Windows there is nothing left to ask nicely.
 *
 * `/T` on both Windows paths: `pnpm dev` is a tree (pnpm → tsx → node), and killing only the root leaves
 * the child that actually holds :8787 running with no parent to reap it.
 */
export function terminate(pids, { hard = false } = {}) {
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (isWindows) {
      tryRun("taskkill", hard ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"], { timeout: 10_000 });
      continue;
    }
    try {
      process.kill(pid, hard ? "SIGKILL" : "SIGTERM");
    } catch {
      // already gone, or not ours — nothing to do either way
    }
  }
}

/**
 * TERM → wait → TERM → wait → KILL, then confirm the port is free. Returns true if it is.
 * Used for the ports we own; a foreign process is never passed in here.
 */
export async function freePort(port, { graceMs = 600 } = {}) {
  if (!(await isListening(port))) return true;
  terminate(pidsOnPort(port), { hard: false });
  if (await waitUntil(async () => !(await isListening(port)), { timeoutMs: graceMs, everyMs: 100 })) return true;
  terminate(pidsOnPort(port), { hard: false });
  if (await waitUntil(async () => !(await isListening(port)), { timeoutMs: graceMs, everyMs: 100 })) return true;
  terminate(pidsOnPort(port), { hard: true });
  return waitUntil(async () => !(await isListening(port)), { timeoutMs: 2000, everyMs: 100 });
}
