#!/usr/bin/env node
/**
 * Rotating stdout sink — a dependency-free `tee` with size-based rotation.
 *
 * The web app is launched by scripts/dev/launch.mjs, which spawns `pnpm dev`
 * and pipes its stdout+stderr into `node log_rotate_pipe.mjs <file>`. (That
 * used to be a bash one-liner using process substitution — `> >(…)` — which is
 * why the launcher is now a program: bash is not a given on Windows.)
 * Everything the process prints on stdout+stderr is streamed
 * here and appended to <file>. When <file> would exceed the size cap it is
 * rotated (file → file.1 → file.2 …, oldest dropped) and reopened empty — so
 * the catch-all boot/console log is bounded exactly like the app's own
 * log.log / error.err files, instead of growing without limit.
 *
 * Before this existed the justfile did `> /tmp/lfb.webapp.log 2>&1`, a raw
 * shell redirect with NO rotation — the launcher log grew unbounded.
 *
 * Policy MUST match src/shared/logging.ts (same env vars, same defaults) so
 * every LargeFileBridge log file obeys one rule:
 *   LFB_LOG_MAX_BYTES     max bytes per file  (default 5 MiB)
 *   LFB_LOG_GENERATIONS   rotated files kept  (default 5)
 *
 * Self-contained (no imports from dist/) so it runs at launch without a build
 * and can be dropped verbatim into any sibling app's launcher.
 *
 * Robustness: this process sits between the app and its log. It must never
 * crash the pipe — all filesystem errors are swallowed, and if stdout can't be
 * written we drop the line rather than throw.
 */

import { closeSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  process.stderr.write('log_rotate_pipe: usage: node log_rotate_pipe.mjs <logfile>\n')
  process.exit(2)
}

function envInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const MAX_BYTES = envInt('LFB_LOG_MAX_BYTES', 5 * 1024 * 1024)
const GENERATIONS = envInt('LFB_LOG_GENERATIONS', 5)

function fileSize(f) {
  try { return statSync(f).size } catch { return 0 }
}

/** Shift file.N chain and move the live file to file.1. Returns true if cleared. */
function rotate(f) {
  try { rmSync(`${f}.${GENERATIONS}`, { force: true }) } catch { /* ignore */ }
  for (let i = GENERATIONS - 1; i >= 1; i--) {
    try { renameSync(`${f}.${i}`, `${f}.${i + 1}`) } catch { /* generation absent */ }
  }
  try { renameSync(f, `${f}.1`); return true } catch { return fileSize(f) === 0 }
}

// A DESCRIPTOR, not a write stream, and closed before every rotation: WINDOWS CANNOT RENAME AN OPEN FILE.
// With a stream held open across `rotate()`, every rename failed there with EPERM/EBUSY, `rotate()`
// answered false forever, and the launcher log grew without limit — the exact unbounded growth this file
// exists to prevent, on the one platform nobody was watching. Synchronous writes also mean nothing sits in
// a userland buffer when the app is killed, so the last lines before a crash are on disk.
let fd = openFd()
let bytes = fileSize(file)

function openFd() {
  try { return openSync(file, 'a') } catch { return -1 }
}

function reopen() {
  if (fd >= 0) { try { closeSync(fd) } catch { /* ignore */ } }
  fd = openFd()
  bytes = fileSize(file)
}

function write(chunk) {
  const len = chunk.length
  if (bytes > 0 && bytes + len > MAX_BYTES) {
    if (fd >= 0) { try { closeSync(fd) } catch { /* ignore */ } fd = -1 }
    rotate(file)
    reopen() // whether or not the rename worked — a failed rotation must not cost us the sink
  }
  if (fd < 0) return // the log is unopenable; drop the line rather than throw
  try { writeSync(fd, chunk) } catch { /* never crash the pipe */ }
  bytes += len
}

process.stdin.on('data', (chunk) => {
  try { write(chunk) } catch { /* swallow — logging must never crash */ }
})
process.stdin.on('end', () => { if (fd >= 0) { try { closeSync(fd) } catch { /* ignore */ } } })
process.stdin.on('error', () => {})
