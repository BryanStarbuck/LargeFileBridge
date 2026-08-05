# 2026-08-05 — The task runner only ever ran on macOS

The 2026-08-04 sweeps made the app's **background workers** cross-platform
([the Windows one](./2026-08-04_autocommit-and-sync-never-run-on-windows.md), [the
follow-on](./2026-08-04_autocommit-cross-platform-and-the-enabled-switch.md)) and named what they had not
reached: *"Still Windows-unbuilt: … the app-launch layer (`justfile`, `web-port.mjs`'s `lsof` +
`/tmp/lfb.web.port`)."* That is this entry. The `justfile` now runs on **macOS, Linux and Windows**.

## Symptom

`just run`, `just stop`, `just status`, `just logs` and `just boot` were macOS recipes. On Windows they
could not run at all; on a stock Linux most of them ran and lied.

The dangerous one is `stop`. It is a dependency of `run`, and its failure mode is silence: a stop that
reaps nothing is indistinguishable from a stop that had nothing to reap. The next `run` then starts a
second instance against the first one's ports.

## Root cause

Every recipe was a bash script, and the load-bearing parts of each were tools that are not there:

| what the recipe needed | how it asked | macOS | Linux | Windows |
| --- | --- | --- | --- | --- |
| who holds a port | `lsof -ti tcp:… -sTCP:LISTEN` | ✅ | ✗ not installed by default | ✗ |
| who is in our dev tree | `pgrep -f` | ✅ (truncated argv) | ✅ | ✗ |
| stop it | `kill -TERM` / `-KILL` | ✅ | ✅ | ✗ no signals |
| background start | `nohup … > >(node sink) 2>&1 &` | ✅ | ✅ | ✗ no bash, no process substitution |
| follow the logs | `tail -f a b c d` | ✅ | ✅ | ✗ |
| start at login | `launchctl` + a plist, `plutil -lint` | ✅ | ✗ | ✗ |
| the node/just binaries | `/opt/homebrew/bin/{just,node}` | ✅ | ✗ | ✗ |

Four more, one layer down, that would have stopped `just run` on Windows even with a perfect justfile:

1. **The port handshake had nowhere to land.** Vite publishes its resolved port to `/tmp/lfb.web.port`
   (`web-port.mjs`). Node reads a literal `/tmp` on Windows as `<drive>:\tmp`, which does not exist — so
   `run` would have waited out its full timeout against a healthy app, and `lfb status` would always have
   said "port not recorded".
2. **The backend could not start.** `"dev": "NODE_OPTIONS=\"…\" tsx watch src/main.ts"` is POSIX-sh
   syntax; cmd.exe reads it as a program *named* `NODE_OPTIONS=--max-old-space-size=6144 …`. package.json
   said so in a comment and accepted it, on the grounds that the app was macOS-targeted.
3. **The launcher log could never roll.** `log_rotate_pipe.mjs` renamed the live file while its own write
   stream held it open. POSIX allows that; Windows does not, so every rotation failed, `rotate()` returned
   false forever, and the one log with no size bound would have been the launcher's.
4. **`.cmd` shims cannot be spawned.** `pnpm` on Windows is `pnpm.cmd`, and Node has refused to run one
   without a shell since 20.12 (CVE-2024-27980) — which also broke the CLI's own bring-up path
   (`cli/code/src/bringup.ts`), the thing that exists to do the justfile's job when `just` is absent.

## The fix

**The justfile is now an interface, not an implementation.** Every recipe is one portable command line —
`node`, `pnpm`, `just`, nothing else — and the work moved to `scripts/dev/*.mjs`. Three rules, stated at
the top of the file, keep it that way; all three are load-bearing on Windows:

1. no shell built-ins or Unix tools in a recipe (`pnpm -C <dir>`, never `cd <dir> && pnpm`);
2. no comment lines **inside** a recipe body — `just` hands those to the shell, and `#` is a comment to
   bash and an unknown command to cmd.exe;
3. no shebang recipes, which are bash scripts by another name.

| file | what it owns |
| --- | --- |
| `scripts/dev/paths.mjs` | the state root, the runtime scratch dir, log paths, ports — one resolver, in lockstep with `config/state-dir.ts` |
| `scripts/dev/proc.mjs` | ports and process trees: `lsof`→`ss`→`fuser` / `netstat -ano`; `ps -ww` / CIM `Win32_Process`; SIGTERM-SIGKILL / `taskkill /T [/F]`; portable `.cmd`-safe spawning |
| `scripts/dev/launch.mjs` | the detached launcher — spawns `pnpm dev`, pipes stdout+stderr into the rotating sink, records both pids |
| `scripts/dev/boot.mjs` | start-at-login: launchd LaunchAgent / Task Scheduler logon task (UTF-16LE XML + a hidden `.vbs`) / systemd **user** unit |
| `scripts/dev/dev.mjs` | `run` `stop` `status` `logs` `clean` `boot` `paths` and the preflight checks |

Matching happens in JS now, over `ps -ww -eo pid=,args=` (or CIM), against groups of substrings that must
**all** appear in one command line — `<code>/` **and** `src/main.ts`. That is what keeps a matcher
repo-scoped without a regex, and it fixed macOS's truncated-`pgrep` problem as a side effect.

**A clean stop that works where there is no SIGTERM.** `POST /api/internal/shutdown` (loopback-only, like
everything on that router) runs the same handler the signals do, so the ledger's SHUTDOWN marker is
written by the app itself. Windows has no SIGTERM — `taskkill` without `/F` posts WM_CLOSE and a console
process never sees it — so without this route every `just stop` there would have reaped the backend by a
route that runs none of its JavaScript, and **every ordinary restart would have been reported as a crash**
at the next boot. That is the 2026-07-20 "42× ended ABNORMALLY" failure, rebuilt on a new platform.
`cmdStop` asks first, waits, and only then signals and frees ports; the POSIX signal path is still there
as the fallback.

**The four one-layer-down fixes.** `runtimeDir()` (`/tmp` on macOS and Linux verbatim, `os.tmpdir()` on
Windows) with the writer and both readers kept in lockstep; `scripts/node-heap-run.mjs`, which sets the
heap ceiling portably and is now the single place the flags and their derivation live;
`log_rotate_pipe.mjs` closing its descriptor before renaming (and writing synchronously, so nothing sits
in a buffer when the app is killed); and `cmd.exe /d /s /c` wrappers wherever a `.cmd` shim is spawned —
`proc.mjs` `spawnTool()`, mirrored by hand in `bringup.ts` `toolCommand()`.

**The CLI shim is Node now** (`cli/lfb.mjs`, with one-line `cli/lfb` and `cli/lfb.cmd` entry points), so
`lfb` exists on Windows at all; it was a bash script using `find -newer` for its staleness check.

## Known and left alone

* **This does not make the whole app Windows-complete.** IPFS auto-start on reboot is still darwin-only
  (`ipfs-autostart.service.ts` `supported()`), so on Windows and Linux the daemon starts with the app and
  not before it.
* **`just boot on` needs systemd on Linux.** Without it there is no user-session service manager to
  register with, and the recipe says so and exits non-zero rather than writing a unit nobody reads.
* **A wedged backend still dies hard on Windows.** If the app cannot answer its own shutdown route, the
  escalation is `taskkill /T /F` and the session is recorded as abnormal — which it was. The marker's
  value is precisely that it is not forged.
* **The launcher still does not restart the dev tree on exit** (crash_recovery.mdx §6.2 wants that). The
  supervisor that would host that loop now exists — `launch.mjs` — but the loop itself is not written.
