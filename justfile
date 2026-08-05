# LargeFileBridge — task runner (sister-app convention). Run `just` to list.
#
# THIS FILE RUNS ON macOS, LINUX AND WINDOWS. That is a deliberate constraint, and it is what shapes
# everything below. Every recipe is one portable command line — `node`, `pnpm`, `just` and nothing else —
# because the interesting work lives in scripts/dev/*.mjs, where the platform differences are handled once
# (see the header of scripts/dev/dev.mjs for what moved and why). Before, these recipes were bash scripts
# built out of `lsof`, `pgrep`, `launchctl`, `plutil`, `nohup`, process substitution and `tail -f`: none of
# those exists on Windows, and `lsof`/`launchctl` are absent from a stock Linux too, so `run`, `stop`,
# `status`, `logs` and `boot` were macOS-only recipes that failed quietly everywhere else.
#
# THE RULES for editing this file, all three of which are load-bearing on Windows:
#   1. NO shell built-ins or Unix tools in a recipe — no `cd`, `test`, `cp`, `rm`, `mkdir`, `tail`, `kill`.
#      Reach for `pnpm -C <dir>` (never `cd <dir> && pnpm`) or add a command to scripts/dev/dev.mjs.
#   2. NO comment lines INSIDE a recipe body. `just` passes them to the shell; `#` is a comment to bash and
#      an unknown command to cmd.exe. Comments go above the recipe, at column 0, like these.
#   3. NO shebang recipes (`#!/usr/bin/env bash`) — that is a bash script by another name.
#
# Ports are read from the environment by scripts/dev/paths.mjs, so BE_PORT / FE_PORT still make the task
# runner agree with the app. The web port is RESOLVED on boot by Vite (collision policy, code_plan.mdx §2)
# and published to the port file; `just status` and `just stop` read it from there.

set shell := ["bash", "-uc"]
set windows-shell := ["cmd.exe", "/d", "/c"]

code := justfile_directory() / "code"
cli := justfile_directory() / "cli"
dev := justfile_directory() / "scripts/dev/dev.mjs"

default:
    @just --list

# Fail fast (with a per-platform install hint) if node or pnpm is missing.
_check-tools:
    @node "{{dev}}" check-tools

# Verify OpenAuthFederated is checked out next to this repo. Both packages consume it via `link:` deps
# (@auth/backend, @auth/react); `pnpm install` dies outright if it is absent.
_check-auth-lib:
    @node "{{dev}}" check-auth-lib

# The install goes through `dev.mjs install`, not bare `pnpm install`, because "Already up to date" is a
# claim about the LOCKFILE and not about node_modules: on Windows pnpm's package links are junctions that
# hold ABSOLUTE paths, so a repo that was moved keeps a tree pnpm calls complete and nothing can resolve.
# It verifies and repairs (scripts/dev/deps.mjs `ensureInstalled`).
#
# Install deps (verified) + seed backend .env.
setup: _check-tools _check-auth-lib
    @node "{{dev}}" install
    @node "{{dev}}" seed-env
    @echo Setup complete.

# Build the CLI (cli/ — pm/cli.mdx §1.3): root build/run always bring it fully up to date too.
build-cli:
    @node "{{dev}}" install --cli
    pnpm -C "{{cli}}/code" build

# Typecheck / build every package (and the CLI — cli.mdx §1.3).
build: setup build-cli
    pnpm -C "{{code}}" -r build

# Typecheck every package (no build output).
typecheck:
    pnpm -C "{{code}}" -r typecheck

# Run the test scripts in every package.
test:
    pnpm -C "{{code}}" -r test

# `run` STOPS OUR PREVIOUS INSTANCE FIRST — that is inside `dev.mjs run`, not a recipe dependency, so the
# restart is a single ordered operation — and then hands off to the detached launcher, which streams the
# dev tree's stdout+stderr through the rotating sink into the launcher log. Vite resolves the web port on
# boot, so a FOREIGN process on :2222 is stepped around rather than killed.
#
# Start backend (:8787) + web app (:2222, collision-resolved) in the background.
run: setup build-cli
    @node "{{dev}}" run

# Foreground dev (both packages, watch mode).
dev: setup
    pnpm -C "{{code}}" dev

# The backend is asked to stop over its own loopback route FIRST, so it writes the ledger's SHUTDOWN
# marker itself; a BOOT with no SHUTDOWN above it is what the ledger defines as a CRASH, and reaping the
# process by any route that runs none of its JavaScript turns every ordinary restart into a reported
# crash. Only then does the tree get signalled and the ports forcibly freed (scripts/dev/dev.mjs cmdStop).
#
# Stop OUR app only — the web app (Vite) AND the backend dev tree — and wait for the ports to be free.
stop:
    @node "{{dev}}" stop

# Follow the launcher catch-all log.
logs:
    @node "{{dev}}" logs

# log.log is what the app SAID; transactions.log is what it DID: a BEGIN/END pair per unit of work, plus
# BOOT/SHUTDOWN/HEARTBEAT. A BOOT with no SHUTDOWN above it means the process CRASHED.
#
# Follow the work ledger — what the app DID (the primary debugging surface).
txlog:
    @node "{{dev}}" logs --txn

# Each of the four answers a different question and no single file answers them all: log.log = what the
# app said, error.err = what broke, transactions.log = what it DID, launcher.log = whether the PROCESS
# died (the ONLY place a V8 OOM abort appears — abort(3) runs no JS, so our writers never fire).
#
# Follow all four logs at once (launcher + log.log + error.err + the ledger).
logs-all:
    @node "{{dev}}" logs --all

# The BACKEND is what this exists to assert. On 2026-07-15 it OOMed and stayed dead ~6 hours while Vite
# served :2222 at HTTP 200 the whole time — `tsx watch` restarts on file change, never on crash. FRONTEND
# UP != APP UP, so a dead backend is reported loudly here and exits non-zero.
#
# Report the backend (:8787, health-checked), the web app, the background agents and start-at-reboot.
status:
    @node "{{dev}}" status

# Where every path resolved on THIS machine (state root, logs, port/pid files, ports).
paths:
    @node "{{dev}}" paths

# `on` registers a login job with whatever this OS uses — a launchd LaunchAgent, a Task Scheduler task
# with a logon trigger, or a systemd user unit — and starts it immediately, so you do not have to reboot
# to find out whether it works. It runs `node scripts/dev/dev.mjs boot-run`: `pnpm install`, then the same
# background start as `just run`. `off` removes the registration; it does NOT stop a running app (that is
# `just stop`).
#
# This is INDEPENDENT of `just install-agents` (the scan/pin/device workers). Turning boot on does not
# install those, and uninstalling those does not turn boot off.
#
# Auto-start the web app at every login: `just boot on` | `just boot off` | `just boot status`.
boot mode="status":
    @node "{{dev}}" boot {{mode}}

# One-shot discovery scan (no waiting for the 4h agent) — same code path the agent runs.
scan: setup
    pnpm -C "{{code}}/packages/backend" cli scan

# One-shot IPFS pin/add (no waiting for the 15m agent) — same code path the agent runs.
pin: setup
    pnpm -C "{{code}}/packages/backend" cli pin

# Install + enable both background agents (scan 4h, pin 15m) with this OS's scheduler.
install-agents: setup
    pnpm -C "{{code}}/packages/backend" cli install-agent scan
    pnpm -C "{{code}}/packages/backend" cli install-agent pin

uninstall-agents:
    pnpm -C "{{code}}/packages/backend" cli uninstall-agent scan
    pnpm -C "{{code}}/packages/backend" cli uninstall-agent pin

# Re-run `just setup` after. Leaves the app's own log.log / error.err in the state dir intact.
#
# Remove installed deps and background run state (node_modules + pid/port scratch + launcher log).
clean:
    @node "{{dev}}" clean
