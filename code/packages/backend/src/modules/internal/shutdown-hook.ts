// The one way anything other than a signal can ask this process to stop CLEANLY.
//
// WHY IT EXISTS. `shutdown()` in main.ts is the only place allowed to write the ledger's SHUTDOWN marker,
// and its absence before the next BOOT is what the ledger DEFINES as a crash (crash_recovery.mdx §5.1).
// On macOS and Linux the task runner gets that marker written by sending SIGTERM. WINDOWS HAS NO SIGTERM:
// `process.kill` there is TerminateProcess, `taskkill` without `/F` posts WM_CLOSE and a console process
// never sees it — so every `just stop` on Windows would kill the backend by a route that runs none of its
// JavaScript, and every ordinary restart would be reported to the user as a crash. Asking over the
// loopback API is the graceful stop that works identically on all three.
//
// A hook rather than an exported function: `shutdown()` is a closure over main()'s server/heartbeat/watcher
// state and cannot be lifted out without dragging all of it along.
type ShutdownFn = (reason: string) => void;

let hook: ShutdownFn | null = null;

/** Registered by main.ts as soon as its shutdown handler exists (right after the BOOT marker). */
export function setShutdownHook(fn: ShutdownFn): void {
  hook = fn;
}

/** Run the clean shutdown. False when none is registered yet — the caller decides what to do about it. */
export function requestShutdown(reason: string): boolean {
  if (!hook) return false;
  hook(reason);
  return true;
}
