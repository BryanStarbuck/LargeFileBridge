#!/usr/bin/env node
// Run a command with the app's HEAP CEILING set — on macOS, Linux and Windows.
//
// The ceiling used to be set inline in the backend's package.json scripts:
//
//     "dev": "NODE_OPTIONS=\"--max-old-space-size=6144 …\" tsx watch src/main.ts"
//
// `VAR=value cmd` is POSIX-sh syntax. cmd.exe and PowerShell parse it as a program NAMED
// `NODE_OPTIONS=--max-old-space-size=6144 …`, so on Windows `pnpm dev` failed before the backend was ever
// started — which made `just run` unusable there regardless of anything the task runner did. That was
// acknowledged in package.json ("this app is macOS-targeted, so plain inline env here is acceptable") and
// is no longer true: the task runner runs on all three now.
//
// WHY THE FLAGS (unchanged, and the reasoning is package.json's — kept here because this is where they
// now live). memory.mdx P-31/P-32 + invariant 4: the heap ceiling is a DECISION, never V8's accidental
// default. On 2026-07-15 a 1,440-file AI-description batch hit V8's implicit ~4GB old-space and aborted
// with "Ineffective mark-compacts near heap limit", silently vaporizing ~1,290 queued files. Nobody chose
// that 4GB and nothing measured how close we were to it.
//
// WHY 6144MB: it is derived, not copied. memory.mdx §1.3 costs a saturated 24-way describe bucket at
// ~1.6-2.2GB of live payload; memory.mdx §2.1 spends at most half the ceiling on those reservations
// (max_memory_fraction, default 0.5). 6GB gives that budget ~3GB — enough to hold the observed peak with
// real GC headroom, where the old 4GB left only ~2GB and lost the race. We deliberately did NOT go higher
// — a bigger ceiling only buys time, and buying time is how you hide the real bug. The CURE is the
// byte-based admission gate (P-28); this is the BACKSTOP behind it.
//
// `--heapsnapshot-near-heap-limit=1`: an OOM abort runs no JS, so our handlers can never fire. This makes
// V8 itself dump one heap snapshot on the way down — the only postmortem artifact obtainable from a
// failure mode that is structurally invisible to our logging.
//
// OVERRIDABLE: our flags go FIRST and the caller's $NODE_OPTIONS is appended after them, so a
// user-supplied --max-old-space-size wins (V8 takes the last occurrence). We set a default; we do not
// overrule.
import { spawnTool } from "./dev/proc.mjs";

const OURS = "--max-old-space-size=6144 --heapsnapshot-near-heap-limit=1";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("node-heap-run: usage: node scripts/node-heap-run.mjs <command> [args…]\n");
  process.exit(2);
}

const child = spawnTool(command, args, {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: `${OURS} ${process.env.NODE_OPTIONS ?? ""}`.trim() },
});

// Forward the stop signals rather than dying and orphaning the child: the backend writes the ledger's
// SHUTDOWN marker from its own SIGINT/SIGTERM handler, and a marker lost here reads as a crash at the
// next boot (crash_recovery.mdx §5.1). Windows has no such signals, and nothing sends them there.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  });
}

child.on("error", (e) => {
  process.stderr.write(`node-heap-run: ${command}: ${e?.message || e}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(typeof code === "number" ? code : signal ? 1 : 0));
