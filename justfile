# LargeFileBridge — task runner (sister-app convention). Run `just` to list.
set shell := ["bash", "-uc"]

code := justfile_directory() + "/code"

# Ports are overridable from the environment so the justfile agrees with the app
# when BE_PORT / FE_PORT are set (Vite resolves the web port on boot — see `run`).
be_port := env_var_or_default("BE_PORT", "8787")
fe_port := env_var_or_default("FE_PORT", "2222")   # web app default; may be collision-resolved higher (code_plan.mdx §2)

# OpenAuthFederated — the auth library both packages depend on via `link:` deps
# (@auth/backend and @auth/react, four levels up at ../../../../OpenAuthFederated).
# `pnpm install` fails outright if the repo has not been cloned, so we check first.
auth_lib  := justfile_directory() + "/../OpenAuthFederated"
auth_repo := "https://github.com/BryanStarbuck/OpenAuthFederated.git"

# The app's local storage / state root — MUST match backend config/state-dir.ts (resolveStateDir):
# $LFB_STATE_DIR, else ~/T/_large_files_bridge. The app's own rotating logs (log.log / error.err) live
# here, and so does the launcher catch-all below — NO log files in /tmp (CLAUDE.md logging policy).
state_dir := env_var_or_default("LFB_STATE_DIR", home_directory() + "/T/_large_files_bridge")

webport  := code + "/packages/frontend/scripts/web-port.mjs"
logpipe  := justfile_directory() + "/scripts/log_rotate_pipe.mjs"   # dependency-free rotating sink (5 MiB × 5)
# Runtime scratch (pid/port) stays in /tmp — cleared on reboot so stale pidfiles never linger; these are
# NOT logs. The launcher log itself lives in the state dir and rotates (5 MiB × 5).
portfile := "/tmp/lfb.web.port"
pidfile  := "/tmp/lfb.webapp.pid"
log      := state_dir + "/launcher.log"

# launchd agent labels (schedule.service.ts: scan = 4h discovery, pin = 15m).
scan_label := "com.largefilebridge.scan"
pin_label := "com.largefilebridge.pin"

default:
    @just --list

# Fail fast (with a fix hint) if a required Homebrew tool is missing.
_check-tools:
    #!/usr/bin/env bash
    set -euo pipefail
    ok=1
    for tool in node pnpm; do
      command -v "$tool" >/dev/null 2>&1 || { echo "✗ missing '$tool' — install with: brew install $tool" >&2; ok=0; }
    done
    [ "$ok" = 1 ] || { echo "Fix the above and re-run." >&2; exit 1; }

# Verify OpenAuthFederated is checked out locally. Both packages consume it via
# `link:` deps (@auth/backend, @auth/react); `pnpm install` dies if it is absent.
_check-auth-lib:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -d "{{auth_lib}}/code/packages/auth-backend" ] && [ -d "{{auth_lib}}/code/packages/auth-react" ]; then
      exit 0
    fi
    root="{{auth_lib}}"
    parent="$(cd "$(dirname "$root")" 2>/dev/null && pwd || true)"
    [ -n "$parent" ] && root="$parent/$(basename "$root")"
    {
      printf '\n✗ OpenAuthFederated is not available locally.\n\n'
      printf "  This app's authentication depends on it via link: deps:\n"
      printf '      @auth/backend → code/packages/auth-backend\n'
      printf '      @auth/react   → code/packages/auth-react\n'
      printf '  Expected location: %s\n\n' "$root"
      printf '  Clone it so the link: paths resolve, then re-run:\n\n'
      printf '      git clone %s "%s"\n\n' "{{auth_repo}}" "$root"
    } >&2
    exit 1

# Install deps + seed backend .env.
setup: _check-tools _check-auth-lib
    cd {{code}} && pnpm install
    cd {{code}}/packages/backend && test -f .env || cp .env.example .env
    @echo "Setup complete."

# Typecheck / build every package.
build: setup
    cd {{code}} && pnpm -r build

# Typecheck every package (no build output).
typecheck:
    cd {{code}} && pnpm -r typecheck

# Run the test scripts in every package.
test:
    cd {{code}} && pnpm -r test

# Vite resolves the web port on boot (takes over our own stale instance; steps past a foreign one),
# so we do NOT blanket-kill :2222 here — we only stop OUR previous instance first.
# Start backend (:8787) + web app (:2222, collision-resolved) in the background.
run: setup stop
    -@rm -f {{portfile}}
    @mkdir -p "{{state_dir}}"   # ensure the local storage / log dir exists before the sink opens the log
    # Stream stdout+stderr THROUGH the rotating sink so {{log}} is size-bounded (5 MiB × 5) instead of
    # growing unbounded. Process substitution keeps `$!` = the app pid (nohup pnpm dev), not the sink,
    # so `stop`/pidfile still target the app. `exec node` avoids leaving an extra shell around the sink.
    cd {{code}} && nohup pnpm dev > >(exec node "{{logpipe}}" "{{log}}") 2>&1 & echo $! > {{pidfile}}
    @echo "Starting… (logs: {{log}}, rotating via scripts/log_rotate_pipe.mjs)"
    @for i in $(seq 1 60); do \
      if [ -f {{portfile}} ] && lsof -ti tcp:$(cat {{portfile}}) >/dev/null 2>&1 && lsof -ti tcp:{{be_port}} >/dev/null 2>&1; then \
        p=$(cat {{portfile}}); echo "Up: http://localhost:$p  (API :{{be_port}})"; exit 0; fi; \
      sleep 0.5; done; \
      echo "Timed out waiting for ports — see {{log}}"; tail -30 {{log}}; exit 1

# Foreground dev (both packages, watch mode).
dev: setup
    cd {{code}} && pnpm dev

# Stop OUR app only — BOTH the frontend (Vite) and the backend dev tree — then confirm the ports are
# actually free before returning. This is what makes `just run` (which depends on `stop`) a true
# restart: front-end AND back-end are torn down first, every time.
#
# Why the tree-kill AND the port loop are both needed:
#   * macOS `pgrep -f` only sees a TRUNCATED command line. The backend `tsx watch` PARENT is matched
#     (short argv, ends in "src/main.ts"), but its node CHILD that actually binds :8787 has a ~1 KB
#     argv whose trailing "src/main.ts" is past the truncation cut — so a name match alone can never
#     reap the child. We kill the parent by name (stops the respawn source) and the child by PORT.
#   * `tsx watch` respawns its child on any source edit. On this repo the tree is continuously
#     auto-committed, so a naive one-shot kill races the respawn and leaves an orphan holding
#     backend.lock — every later `just run` backend then exit(0)s on boot and the API never comes up
#     (the "orphan swarm"). The port loop below kills-and-rechecks until :be_port and the web port are
#     genuinely free, defeating that race.
# All matchers are repo-scoped (our @lfb/ pnpm scope, our {{code}} path, or "src/main.ts") so sister
# apps and the launchd pin/scan worker (which runs src/cli.ts under deploy/, never src/main.ts or
# --parallel dev) are never touched.
stop:
    #!/usr/bin/env bash
    set -uo pipefail
    self=$$
    fe_port=$(test -f {{portfile}} && cat {{portfile}} 2>/dev/null || echo {{fe_port}})
    # Collect this repo's dev-tree pids from three narrow matchers (run separately so we stay in the
    # BRE subset `.*`, avoiding any pgrep ERE-alternation portability question):
    #   @lfb/…--parallel dev   → the pnpm dev orchestrator (NOT `pnpm cli pin`)
    #   {{code}}/packages/frontend → the Vite dev server
    #   {{code}}…src/main.ts   → the backend `tsx watch` parent (NOT src/cli.ts pin runs)
    kill_tree() { # $1 = signal
      local pids
      pids=$( { pgrep -f "@lfb/.*--parallel dev"; \
                pgrep -f "{{code}}/packages/frontend"; \
                pgrep -f "{{code}}.*src/main.ts"; } 2>/dev/null | sort -u | grep -vx "$self" || true )
      [ -n "$pids" ] && kill -"$1" $pids 2>/dev/null || true
    }
    kill_tree TERM; sleep 0.6; kill_tree TERM; sleep 0.6; kill_tree KILL
    # Belt-and-suspenders: free the backend port and the web port, catching a child that reparented
    # mid-restart. Loop until both are free (or we give up after a few rounds).
    for round in 1 2 3 4 5 6; do
      held=""
      for port in {{be_port}} "$fe_port"; do
        p=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
        if [ -n "$p" ]; then held="yes"; kill -TERM $p 2>/dev/null || true; fi
      done
      [ -z "$held" ] && break
      sleep 0.4
      for port in {{be_port}} "$fe_port"; do
        p=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
        [ -n "$p" ] && kill -KILL $p 2>/dev/null || true
      done
    done
    test -f {{pidfile}} && kill "$(cat {{pidfile}})" 2>/dev/null || true
    rm -f {{pidfile}}
    echo "Stopped."

logs:
    tail -f {{log}}

# Report the web app + backend ports and whether the two launchd agents are loaded.
status:
    @p=$(test -f {{portfile}} && cat {{portfile}} || echo {{fe_port}}); \
      lsof -ti tcp:$p >/dev/null 2>&1 && echo "web app  :$p UP" || echo "web app  :$p down"
    @lsof -ti tcp:{{be_port}} >/dev/null 2>&1 && echo "backend  :{{be_port}} UP" || echo "backend  :{{be_port}} down"
    @launchctl list | grep -q {{scan_label}} && echo "agent scan  (4h)  LOADED" || echo "agent scan  (4h)  not loaded"
    @launchctl list | grep -q {{pin_label}} && echo "agent pin   (15m) LOADED" || echo "agent pin   (15m) not loaded"

# One-shot discovery scan (no waiting for the 4h agent) — same code path the agent runs.
scan: setup
    cd {{code}}/packages/backend && pnpm cli scan

# One-shot IPFS pin/add (no waiting for the 15m agent) — same code path the agent runs.
pin: setup
    cd {{code}}/packages/backend && pnpm cli pin

# Install + enable both launchd agents (scan 4h, pin 15m).
install-agents: setup
    cd {{code}}/packages/backend && pnpm cli install-agent scan && pnpm cli install-agent pin

uninstall-agents:
    cd {{code}}/packages/backend && pnpm cli uninstall-agent scan && pnpm cli uninstall-agent pin

# Remove installed deps and background run state (node_modules + pid/port scratch + launcher log).
# Re-run `just setup` after. Leaves the app's own log.log / error.err in the state dir intact.
clean: stop
    -@rm -f {{log}} {{pidfile}} {{portfile}}
    rm -rf {{code}}/node_modules {{code}}/packages/*/node_modules
    @echo "Cleaned. Run 'just setup' to reinstall."
