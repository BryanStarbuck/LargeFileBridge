// The BACKBONE FRESHNESS TRIGGER (storage_company.mdx §8.9) — the human-activity backstop that makes a
// peer's file show up here without waiting on a timer.
//
// THE DEFECT THIS CLOSES. `reconcileMirroredRepos()` — the step that turns "the Tower pinned a file" into a
// row on this computer — runs in exactly two places: the `pin` worker's storage pass and the `device`
// worker's text sync. Both are launchd jobs. On the machine this was traced on, those jobs had been
// pointing at a Homebrew node binary that no longer existed, so for their entire lifetime they COULD NOT
// START, and `reconcileMirroredRepos` had never once run: `<SDL>/repos/83e62afc2c80/manifest.yaml` held all
// 59 of the Tower's entries while this computer's tracking manifest held zero, and the One-Repo page showed
// one of the three files the user was looking for. Every link in storage_company.mdx §8.3 was healthy. The
// cargo was on the truck; nobody ever started the engine.
//
// The rule that follows: a chain whose only trigger is a background timer is a chain with a single point of
// failure that fails SILENTLY. Opening the page is a statement of intent — "show me this repo" — and it is
// the moment we should be checking whether what we are about to show is current. This mirrors the scanner's
// existing page-load self-heal (`maybeTriggerStaleScan`, scan-job.ts) and follows the same three rules:
// NON-BLOCKING (never delays the response it fires from), SINGLE-FLIGHT (concurrent page loads coalesce),
// and NEVER THROWS (a freshness trigger must not break the page it fires from).
import { listStorageIds, getStorageRow } from "./storage.service.js";
import { log } from "../../shared/logging.js";

// How stale the last backbone cycle must be before a page load kicks a new one. A full cycle is a git
// fetch + merge + reconcile + commit + push against the user's own SDL — cheap, but not free, and several
// page loads in a row must not mean several cycles. Two minutes keeps an actively-used app effectively
// live while collapsing a burst of navigation into one pass. The scheduled workers (10/15 min) remain the
// backstop for an app nobody is touching.
const BACKBONE_STALE_MS = 2 * 60 * 1000;

let lastCycleAt = 0;
let inFlight: Promise<void> | null = null;

/** Run one text-sync cycle (fetch → merge → reconcile → commit → push) for every storage that has one. */
async function cycleAllStorages(reason: string): Promise<void> {
  // LAZY import: pin.service imports the storage/tracking modules, so a static import here is a cycle.
  const { syncStorageText } = await import("../pin/pin.service.js");
  const ids = listStorageIds();
  for (const id of ids) {
    try {
      const row = getStorageRow(id);
      if (!row) continue;
      const result = await syncStorageText(id);
      if (result.problem) log.warn("storage", `${reason}: storage ${id} (${row.name}) — ${result.problem}`);
    } catch (e) {
      // One bad storage must never stop the others — the whole point is that the OTHER storage's repo
      // still gets its rows.
      log.warn("storage", `${reason}: storage ${id} cycle failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Kick a background backbone cycle IFF the last one is stale — call this on UI page loads (and once at
 * boot). Non-blocking: it returns immediately and the work continues behind the response.
 *
 * Safe to call on every request. It no-ops when a cycle is already running and when a recent cycle makes
 * the data fresh, so a page that renders twenty repo rows still causes at most one pass.
 */
export function maybeSyncBackbone(reason: string): void {
  try {
    if (inFlight) return; // already cycling — a second pass would only contend on the same git lock
    if (Date.now() - lastCycleAt < BACKBONE_STALE_MS) return;
    lastCycleAt = Date.now();
    log.info("storage", `${reason}: backbone cycle is stale — fetching + reconciling in the background.`);
    inFlight = cycleAllStorages(reason)
      .catch((e) => log.warn("storage", `${reason}: backbone cycle failed: ${(e as Error).message}`))
      .finally(() => {
        // Stamp on COMPLETION, not on start: a slow cycle should not immediately re-arm the trigger.
        lastCycleAt = Date.now();
        inFlight = null;
      });
  } catch (e) {
    // A freshness trigger must NEVER break the page it fires from.
    log.debug("storage", `maybeSyncBackbone skipped: ${(e as Error).message}`);
  }
}

/**
 * The BOOT pass — run one cycle at startup regardless of staleness, so an app that has just been opened
 * shows current data on its very first page rather than on the second. Awaited by nobody: boot must not
 * wait on the network.
 */
export function syncBackboneOnBoot(): void {
  lastCycleAt = Date.now();
  inFlight = cycleAllStorages("boot")
    .catch((e) => log.warn("storage", `boot backbone cycle failed: ${(e as Error).message}`))
    .finally(() => {
      lastCycleAt = Date.now();
      inFlight = null;
    });
}
