# LargeFileBridge — task runner (sister-app convention). Run `just` to list.
set shell := ["bash", "-uc"]

code := justfile_directory() + "/code"
be_port := "8787"
fe_port := "8080"
log := "/tmp/lfb.webapp.log"
pidfile := "/tmp/lfb.webapp.pid"

default:
    @just --list

# Install deps + seed backend .env.
setup:
    cd {{code}} && pnpm install
    cd {{code}}/packages/backend && test -f .env || cp .env.example .env
    @echo "Setup complete."

# Typecheck / build every package.
build:
    cd {{code}} && pnpm -r build

# Run backend (:8787) + frontend (:8080) in the background; wait for both ports.
run: setup stop
    cd {{code}} && nohup pnpm dev > {{log}} 2>&1 & echo $! > {{pidfile}}
    @echo "Starting… (logs: {{log}})"
    @for i in $(seq 1 40); do \
      if lsof -ti tcp:{{fe_port}} >/dev/null 2>&1 && lsof -ti tcp:{{be_port}} >/dev/null 2>&1; then \
        echo "Up: http://localhost:{{fe_port}}  (API :{{be_port}})"; exit 0; fi; \
      sleep 0.5; done; \
      echo "Timed out waiting for ports — see {{log}}"; tail -30 {{log}}; exit 1

# Foreground dev (both packages, watch mode).
dev: setup
    cd {{code}} && pnpm dev

stop:
    -@lsof -ti tcp:{{fe_port}} | xargs kill 2>/dev/null || true
    -@lsof -ti tcp:{{be_port}} | xargs kill 2>/dev/null || true
    -@test -f {{pidfile}} && kill $(cat {{pidfile}}) 2>/dev/null || true
    -@rm -f {{pidfile}}
    @echo "Stopped."

logs:
    tail -f {{log}}

status:
    @lsof -ti tcp:{{fe_port}} >/dev/null 2>&1 && echo "frontend :{{fe_port}} UP" || echo "frontend :{{fe_port}} down"
    @lsof -ti tcp:{{be_port}} >/dev/null 2>&1 && echo "backend  :{{be_port}} UP" || echo "backend  :{{be_port}} down"

# Install + enable both launchd agents (scan 4h, sync 15m).
install-agents:
    cd {{code}}/packages/backend && pnpm cli install-agent scan && pnpm cli install-agent sync

uninstall-agents:
    cd {{code}}/packages/backend && pnpm cli uninstall-agent scan && pnpm cli uninstall-agent sync
