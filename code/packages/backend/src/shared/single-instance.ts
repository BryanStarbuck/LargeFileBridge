// One-backend-per-computer guard (storage.mdx §15). The store's read-modify-write mutex is
// PER-PROCESS only — it cannot coordinate across processes. When several backends run at once (the
// classic `tsx watch` orphan swarm, or a stray manual `node main.ts`), their bootstrapState() config
// writes race and a stale reader silently clobbers a fresh write — e.g. it wiped a just-saved
// security allow-list back to defaults. This lock ensures exactly one live backend ever reaches the
// config-writing path.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";

const lockFile = () => path.join(resolveStateDir(), "backend.lock");

/** Is `pid` a live process? signal 0 probes existence without delivering a signal. */
function isAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true; // exists and we may signal it
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but owned by another user
  }
}

let held = false;

/** One acquisition attempt. Returns null on success, or the live holder's pid if someone else owns it. */
function tryAcquire(file: string): number | null {
  try {
    const fd = fs.openSync(file, "wx"); // O_CREAT | O_EXCL — atomic create-or-fail
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    held = true;
    registerCleanup(file);
    return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let holder = 0;
    try {
      holder = Number(fs.readFileSync(file, "utf8").trim()) || 0;
    } catch {
      holder = 0; // raced with a release/reclaim — treat as free and retry
    }
    if (isAlive(holder)) return holder; // a live instance owns it — stand down
    // Stale lock (holder is dead): remove it so the next attempt can atomically re-create.
    try {
      fs.unlinkSync(file);
    } catch {
      /* another booter may have reclaimed it first — the retry will observe that */
    }
    return process.pid; // sentinel "retry" — never a real other-holder (isAlive excludes self)
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Acquire the exclusive backend lock. Returns null once we own it, or the live holder's pid if another
 * instance keeps it for the whole retry window (caller should then exit WITHOUT touching shared state).
 *
 * The retries absorb a normal `tsx watch` restart: the old child gets SIGTERM, releases the lock on
 * exit, and this new child reclaims it within a few hundred ms. A genuine second instance stays alive
 * across the whole window, so we correctly stand down.
 */
export async function acquireSingleInstanceLock(retries = 15, delayMs = 100): Promise<number | null> {
  const file = lockFile();
  let lastHolder = -1;
  for (let i = 0; i <= retries; i++) {
    const holder = tryAcquire(file);
    if (holder === null) return null; // acquired
    if (holder !== process.pid) lastHolder = holder; // a real, live other holder
    if (i < retries) await delay(delayMs);
  }
  return lastHolder;
}

function registerCleanup(file: string): void {
  const release = () => {
    if (!held) return;
    held = false;
    try {
      // Only unlink if we still own it, so we never delete a successor's freshly-taken lock.
      const holder = Number(fs.readFileSync(file, "utf8").trim()) || 0;
      if (holder === process.pid) fs.unlinkSync(file);
    } catch {
      /* best effort — a leftover lock is self-healing via the stale-holder check above */
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      release();
      // Do NOT process.exit() here. Node runs signal listeners in REGISTRATION order, and this one is
      // registered during early boot — long before main.ts installs the app's own shutdown. An immediate
      // exit(0) killed the process from inside this listener, so EVERY later listener was skipped: the app
      // never ran its clean shutdown, and (once the ledger existed) never wrote its SHUTDOWN marker. The
      // symptom was stark and silent: 29 BOOT lines, 0 SHUTDOWN lines — so every ordinary `just stop` was
      // indistinguishable from a crash, which is precisely the distinction transactions_log.mdx §3.1 and
      // crash_recovery.mdx §5 are built on. A lock-release detail was quietly corrupting the crash signal.
      //
      // Instead: release the lock (the only thing THIS module must guarantee), then let the app's own
      // shutdown run. The fallback timer below still guarantees we exit even if nobody else handles the
      // signal (cli.ts, or any future entry point with no shutdown of its own) — but it is `unref()`d, so
      // when the app DOES shut down cleanly and the loop drains, the process exits on its own well before
      // the timer would ever fire. Lock safety is preserved either way: `process.on("exit", release)` above
      // covers every exit path.
      setTimeout(() => process.exit(0), FALLBACK_EXIT_MS).unref();
    });
  }
}

/** How long a signal handler waits for the app's own shutdown before forcing the exit itself. Generous
 *  enough for an in-flight HTTP response to drain, short enough that a wedged shutdown never hangs a stop. */
const FALLBACK_EXIT_MS = 3000;
