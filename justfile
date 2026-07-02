# LargeFileBridge — task runner (sister-app convention). Run `just` to list.
set shell := ["bash", "-uc"]

code := justfile_directory() + "/code"
be_port := "8787"
fe_port := "2222"                       # web app default; may be collision-resolved higher (code_plan.mdx §2)
webport := code + "/packages/frontend/scripts/web-port.mjs"
portfile := "/tmp/lfb.web.port"
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

# Run backend (:8787) + web app (:2222, collision-resolved) in the background.
# Vite resolves the web port on boot (takes over our own stale instance; steps past a foreign one),
# so we do NOT blanket-kill :2222 here — we only stop OUR previous instance first.
run: setup stop
    -@rm -f {{portfile}}
    cd {{code}} && nohup pnpm dev > {{log}} 2>&1 & echo $! > {{pidfile}}
    @echo "Starting… (logs: {{log}})"
    @for i in $(seq 1 60); do \
      if [ -f {{portfile}} ] && lsof -ti tcp:$(cat {{portfile}}) >/dev/null 2>&1 && lsof -ti tcp:{{be_port}} >/dev/null 2>&1; then \
        p=$(cat {{portfile}}); echo "Up: http://localhost:$p  (API :{{be_port}})"; exit 0; fi; \
      sleep 0.5; done; \
      echo "Timed out waiting for ports — see {{log}}"; tail -30 {{log}}; exit 1

# Foreground dev (both packages, watch mode).
dev: setup
    cd {{code}} && pnpm dev

# Stop OUR app only: backend port + our launcher pid + the web port IF it's ours (foreign-safe).
stop:
    -@lsof -ti tcp:{{be_port}} | xargs kill 2>/dev/null || true
    -@node {{webport}} stop >/dev/null 2>&1 || true
    -@test -f {{pidfile}} && kill $(cat {{pidfile}}) 2>/dev/null || true
    -@rm -f {{pidfile}}
    @echo "Stopped."

logs:
    tail -f {{log}}

status:
    @p=$(test -f {{portfile}} && cat {{portfile}} || echo {{fe_port}}); \
      lsof -ti tcp:$p >/dev/null 2>&1 && echo "web app  :$p UP" || echo "web app  :$p down"
    @lsof -ti tcp:{{be_port}} >/dev/null 2>&1 && echo "backend  :{{be_port}} UP" || echo "backend  :{{be_port}} down"

# Install + enable both launchd agents (scan 4h, sync 15m).
install-agents:
    cd {{code}}/packages/backend && pnpm cli install-agent scan && pnpm cli install-agent sync

uninstall-agents:
    cd {{code}}/packages/backend && pnpm cli uninstall-agent scan && pnpm cli uninstall-agent sync
