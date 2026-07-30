// Non-throwing filesystem probes — the ONE way to ask "is this path a file / a directory / how big is
// it" on a hot path.
//
// WHY THIS FILE EXISTS (a measured, not theoretical, win). A CPU profile of the running backend
// (`sample <pid>`, main thread pegged at 100%) attributed **78.7% of all CPU to `fs.statSync`** — and,
// crucially, **64% of ALL CPU to `node::UVException` → `v8::Exception::Error` →
// `CaptureAndSetErrorStack` → `OptimizedJSFrame::Summarize`**. That is not the stat: that is V8
// *constructing the ENOENT Error object and capturing its stack trace*. The app probes for artifacts
// that usually DO NOT exist (analysisOutputs alone fires ~12 probes per file across every artifact
// placement, and nearly all of them miss), and the classic
//
//     try { return fs.statSync(p).isFile(); } catch { return false; }
//
// idiom pays a full V8 exception + stack capture for every single miss. Deoptimized-frame translation
// makes that cost grow with stack depth, which is exactly why a deep walk was the worst offender.
//
// `fs.statSync(p, { throwIfNoEntry: false })` returns `undefined` for ENOENT/ENOTDIR instead of
// throwing, skipping the Error construction entirely. Measured on this machine: **6–9× faster per
// missing-path probe** (4.6 µs → 0.7 µs), and the deeper the call stack the bigger the win.
//
// The `try/catch` is KEPT deliberately. `throwIfNoEntry: false` suppresses only the not-found case;
// EACCES, ELOOP, EIO and friends still throw, and on cloud mounts (~/Library/CloudStorage/…) those are
// real. So these helpers are exactly as total as the idiom they replace — same semantics, minus the
// hot-path exception.
//
// RULE: on any per-file or per-directory path, use these instead of a bare `statSync` in a `try/catch`,
// and prefer them over `existsSync(p) && statSync(p)` (which pays two syscalls for one question).
import fs from "node:fs";

/** `fs.Stats` for `path`, or null if it does not exist or cannot be stat'd. Never throws. */
export function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/** As {@link statOrNull} but does NOT follow symlinks (the `lstat` flavour). Never throws. */
export function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/** True iff `path` exists and is a regular file. Never throws. */
export function isFileAt(p: string): boolean {
  return statOrNull(p)?.isFile() ?? false;
}

/** True iff `path` exists and is a directory. Never throws. */
export function isDirAt(p: string): boolean {
  return statOrNull(p)?.isDirectory() ?? false;
}

/** True iff `path` exists at all (file, dir, or anything else). Never throws. */
export function existsAt(p: string): boolean {
  return statOrNull(p) !== null;
}

/** Size in bytes, or null when the path is missing/unreadable. Never throws. */
export function sizeOrNull(p: string): number | null {
  return statOrNull(p)?.size ?? null;
}

/** Size in bytes, or `0` when the path is missing/unreadable — for byte counters. Never throws. */
export function sizeOrZero(p: string): number {
  return statOrNull(p)?.size ?? 0;
}

/** Modified-time in epoch ms, or null when the path is missing/unreadable. Never throws. */
export function mtimeMsOrNull(p: string): number | null {
  return statOrNull(p)?.mtimeMs ?? null;
}
