// Stale-module recovery. Users leave tabs open across dev-server restarts (Vite :2222) and deploys;
// when Vite re-optimizes deps (or a build ships new chunk hashes) an open page can end up mixing a
// stale module graph with freshly-loaded modules. The two signatures of that class:
//
//   1. Two live React copies in one render — a hook sees a null dispatcher:
//      "Cannot read properties of null (reading 'useContext')" (seen from useQueryClient when the
//      page held @tanstack_react-query.js?v=<old> while QueryClientProvider came from ?v=<new>).
//   2. A dynamic import fails outright because the old chunk URL is gone:
//      "Failed to fetch dynamically imported module" / Vite's `vite:preloadError` event.
//
// Neither is recoverable in-page — the only fix is loading a coherent module graph, i.e. a reload.
// tryStaleModuleReload() does that ONCE, with a sessionStorage timestamp guard so a reload that does
// NOT clear the error (a genuine bug matching the signature) cannot loop the tab.

import { clientLog } from "./clientLog.js";

const RELOAD_AT_KEY = "lfb.staleModuleReloadAt";
// One auto-reload per window. If the error recurs inside the window the reload didn't fix it —
// stop auto-reloading and let the ErrorBoundary card show. Long enough to break a loop, short
// enough that a NEW incident days later in the same long-lived tab still self-heals.
const RELOAD_WINDOW_MS = 60_000;

/** Does this error look like the stale-Vite-module class (split React copies / dead chunk URLs)? */
export function isStaleModuleError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : String((err as { message?: unknown })?.message ?? "");
  return (
    // Null hook dispatcher — the "two React copies" signature (the property read is a hook name).
    /Cannot read properties of null \(reading 'use[A-Z]\w*'\)/.test(msg) ||
    /Invalid hook call/.test(msg) ||
    // Dead/stale chunk URLs after a re-optimization or redeploy.
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  );
}

/**
 * Reload the page to recover from a stale module graph — at most once per RELOAD_WINDOW_MS
 * (sessionStorage-guarded so a persistent error can never loop the tab). Returns true if the
 * reload was initiated, false if the guard blocked it (caller should fall through to its
 * normal error UI).
 */
export function tryStaleModuleReload(source: string): boolean {
  let allowed = false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_AT_KEY) ?? 0);
    allowed = !Number.isFinite(last) || Date.now() - last >= RELOAD_WINDOW_MS;
    if (allowed) sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable → we cannot guard against a loop, so never auto-reload.
    allowed = false;
  }
  if (!allowed) {
    clientLog.warn(source, "stale-module error recurred within the reload guard window — not auto-reloading again");
    return false;
  }
  clientLog.warn(source, "stale module graph detected (Vite re-optimization / redeploy) — auto-reloading once to recover");
  window.location.reload();
  return true;
}
