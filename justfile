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

webport  := code + "/packages/frontend/scripts/web-port.mjs"
logpipe  := justfile_directory() + "/scripts/log_rotate_pipe.mjs"   # dependency-free rotating sink (5 MiB × 5)
portfile := "/tmp/lfb.web.port"
log      := "/tmp/lfb.webapp.log"
pidfile  := "/tmp/lfb.webapp.pid"

# launchd agent labels (schedule.service.ts: scan = 4h discovery, sync = 15m).
scan_label := "com.largefilebridge.scan"
sync_label := "com.largefilebridge.sync"

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

# Stop OUR app only: backend dev tree + backend port + our launcher pid + the web port IF it's ours.
# IMPORTANT — reap the `tsx watch` backend FIRST. Killing only the port holder (lsof :be_port) leaves
# the watch PARENT alive; in watch mode it just respawns a new server child (re-binding the port) or,
# after a single-instance stand-down, lingers as an orphan that keeps HOLDING backend.lock. A live
# lock holder makes every future `just run` backend exit(0) on boot — the API never comes up even
# though `stop` printed "Stopped." This is the orphan swarm the code comments cite as clobbering the
# saved allow-list. Pattern is repo-scoped (anchored on {{code}}) and matches BOTH the watcher
# (`… packages/backend/… tsx … watch src/main.ts`) and its server child (`… tsx … src/main.ts`); it
# never matches this recipe's own shell, which contains {{code}} but not "src/main.ts".
stop:
    -@pkill -f "{{code}}.*src/main.ts" 2>/dev/null || true
    -@lsof -ti tcp:{{be_port}} | xargs kill 2>/dev/null || true
    -@node {{webport}} stop >/dev/null 2>&1 || true
    -@test -f {{pidfile}} && kill $(cat {{pidfile}}) 2>/dev/null || true
    -@rm -f {{pidfile}}
    @echo "Stopped."

logs:
    tail -f {{log}}

# Report the web app + backend ports and whether the two launchd agents are loaded.
status:
    @p=$(test -f {{portfile}} && cat {{portfile}} || echo {{fe_port}}); \
      lsof -ti tcp:$p >/dev/null 2>&1 && echo "web app  :$p UP" || echo "web app  :$p down"
    @lsof -ti tcp:{{be_port}} >/dev/null 2>&1 && echo "backend  :{{be_port}} UP" || echo "backend  :{{be_port}} down"
    @launchctl list | grep -q {{scan_label}} && echo "agent scan  (4h)  LOADED" || echo "agent scan  (4h)  not loaded"
    @launchctl list | grep -q {{sync_label}} && echo "agent sync  (15m) LOADED" || echo "agent sync  (15m) not loaded"

# One-shot discovery scan (no waiting for the 4h agent) — same code path the agent runs.
scan: setup
    cd {{code}}/packages/backend && pnpm cli scan

# One-shot IPFS sync (no waiting for the 15m agent) — same code path the agent runs.
sync: setup
    cd {{code}}/packages/backend && pnpm cli sync

# Install + enable both launchd agents (scan 4h, sync 15m).
install-agents: setup
    cd {{code}}/packages/backend && pnpm cli install-agent scan && pnpm cli install-agent sync

uninstall-agents:
    cd {{code}}/packages/backend && pnpm cli uninstall-agent scan && pnpm cli uninstall-agent sync

# Remove installed deps and background run state (node_modules + /tmp files). Re-run `just setup` after.
clean: stop
    -@rm -f {{log}} {{pidfile}} {{portfile}}
    rm -rf {{code}}/node_modules {{code}}/packages/*/node_modules
    @echo "Cleaned. Run 'just setup' to reinstall."
