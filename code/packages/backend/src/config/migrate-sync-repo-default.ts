// One-time migration: clear the PERSISTED `sync_repo.enabled: false` that was never a user's choice
// (storage_company.mdx §8.4.2 — the mirror is ON by default and the toggle is an OPT-OUT).
//
// The defect this repairs. `sync_repo.enabled` used to be `z.boolean().default(false)`, and because the
// store rewrites a unit's whole config on every update, that default was WRITTEN TO DISK for every repo —
// 178 of them on the machine this was found on. Making the field optional (absent ⇒ ON) was therefore not
// enough on its own: every existing repo still carried an explicit `false`, which the new code correctly
// reads as "the user opted out". The whole cross-computer feature would have stayed dead for exactly the
// people who already had repos, and looked fine only on a fresh install.
//
// Why clearing it is safe. That `false` cannot be a real decision: the only UI that ever wrote it described
// itself as "Off by default", and a user who never opened per-repo settings could not have set it. So a
// persisted `false` is indistinguishable from the old default, and treating it as the default is the honest
// reading. A user who genuinely wants the mirror off can turn it off again — and this migration runs ONCE,
// so their choice then sticks.
//
// Contract (the same as its siblings):
//   * Runs ONCE at startup, guarded by a marker in the state root.
//   * Idempotent: an already-migrated (or absent) state is skipped.
//   * Best-effort and NEVER throws — a failed migration must never crash boot.
//   * Surgical: it removes ONLY the `enabled:` line under `sync_repo:`, leaving every other key, comment,
//     and the file's formatting untouched. An explicit `true` is left alone (it agrees with the default).
import fs from "node:fs";
import path from "node:path";
import { log } from "../shared/logging.js";

const MARKER = ".sync-repo-default-migrated";
const REPAIR_MARKER = ".sync-repo-empty-block-repaired";

/** Strip a `sync_repo: { enabled: false }` block's `enabled` line, leaving the block (and everything else)
 *  intact. Returns the new text, or null when there is nothing to change.
 *
 *  NEVER LEAVE A VALUELESS PARENT KEY. `enabled` is the block's only child, so removing that line used to
 *  leave a bare `sync_repo:` behind — which YAML parses as `null`, not as an empty map, and which
 *  `z.object({...}).prefault({})` rejects outright. That is precisely what happened: this migration ran once
 *  and made all 178 repo unit configs unreadable, taking every repo-level feature down with them (the store
 *  now also repairs this shape on read — yaml-store.ts `dropEmptyBlocks` — but the migration must not create
 *  it in the first place). When the block empties, emit an explicit `sync_repo: {}`. */
export function clearPersistedSyncRepoFalse(yaml: string): string | null {
  const lines = yaml.split("\n");
  let blockStart = -1; // index in `out` of the `sync_repo:` line, while we are inside the block
  let childrenKept = 0;
  let changed = false;
  const out: string[] = [];

  /** Close the current block, collapsing a now-childless `sync_repo:` to `sync_repo: {}`. */
  const closeBlock = () => {
    if (blockStart >= 0 && childrenKept === 0) out[blockStart] = "sync_repo: {}";
    blockStart = -1;
    childrenKept = 0;
  };

  for (const line of lines) {
    if (/^sync_repo:\s*$/.test(line)) {
      closeBlock(); // defensive: a duplicated key can never leave the previous block open
      blockStart = out.length;
      out.push(line);
      continue;
    }
    if (blockStart >= 0) {
      // Still inside the block only while lines are indented; the next top-level key (or a blank line
      // followed by one) ends it. A blank line is not a child, so it must not keep the block "occupied".
      if (/^\s+\S/.test(line)) {
        if (/^\s+enabled:\s*false\s*$/.test(line)) {
          changed = true; // drop this line — absent means "the default", which is ON
          continue;
        }
        childrenKept++;
      } else if (line.trim() !== "") {
        closeBlock();
      }
    }
    out.push(line);
  }
  closeBlock(); // the block may run to end-of-file

  return changed ? out.join("\n") : null;
}

export function migrateSyncRepoDefault(stateDir: string): void {
  try {
    const marker = path.join(stateDir, MARKER);
    if (fs.existsSync(marker)) return; // already run

    const reposDir = path.join(stateDir, "pin", "r");
    let cleared = 0;
    let scanned = 0;
    if (fs.existsSync(reposDir)) {
      for (const entry of fs.readdirSync(reposDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const cfg = path.join(reposDir, entry.name, "config.yaml");
        try {
          if (!fs.existsSync(cfg)) continue;
          scanned++;
          const next = clearPersistedSyncRepoFalse(fs.readFileSync(cfg, "utf8"));
          if (next === null) continue;
          fs.writeFileSync(cfg, next, "utf8");
          cleared++;
        } catch (e) {
          // One unreadable unit must never stop the rest — this is the migration whose whole purpose is to
          // un-break every repo at once.
          log.warn("migrate", `sync_repo default: skipped ${entry.name}: ${(e as Error).message}`);
        }
      }
    }

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
    if (cleared > 0) {
      log.info(
        "migrate",
        `sync_repo default: cleared a persisted "enabled: false" in ${cleared}/${scanned} repo config(s) — ` +
          `the tracking mirror is ON by default (storage_company.mdx §8.4.2); turn it off per repo in settings.`,
      );
    }
  } catch (e) {
    log.warn("migrate", `sync_repo default migration failed (continuing): ${(e as Error).message}`);
  }
}

/** Rewrite a valueless `sync_repo:` line as an explicit empty map. Returns null when there is nothing to fix. */
export function repairEmptySyncRepoBlock(yaml: string): string | null {
  const lines = yaml.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!/^sync_repo:\s*$/.test(lines[i])) continue;
    // A real block has at least one indented, non-blank child line before the next top-level key.
    let hasChild = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      hasChild = /^\s+\S/.test(lines[j]);
      break;
    }
    if (hasChild) continue;
    lines[i] = "sync_repo: {}";
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}

/**
 * THE CLEAN-UP PASS for the damage `migrateSyncRepoDefault` already did on machines where it ran before the
 * fix above (the reference machine: all 178 repo unit configs left with a bare `sync_repo:`, i.e. `null`,
 * which the schema rejects — so every repo unit failed to load and every repo-level feature went dark).
 *
 * NOT marker-gated — this sweep runs on EVERY boot. The first version wrote a one-time marker, and the
 * damage recurred the same day the marker was written (2026-07-20): with the marker present, the repair that
 * existed precisely for this shape was locked out and every repo unit went dark again. The sweep is
 * content-driven and idempotent (a healthy file matches nothing and is never rewritten), and reading ~178
 * small files at boot is cheap — nothing a marker would save is worth a second outage. The marker file is
 * still written, but only as a last-swept timestamp for debugging. Best-effort, never throws — same contract
 * as its siblings. The store also repairs this shape on read (yaml-store.ts `dropEmptyBlocks`) and the
 * schema itself now maps a null block to its defaults (@lfb/shared schemas.ts `nullAsAbsent`); this pass
 * makes the files themselves correct so nothing downstream — another tool, an older build, a human reading
 * YAML — has to know about the workaround.
 */
export function repairEmptySyncRepoBlocks(stateDir: string): void {
  try {
    const marker = path.join(stateDir, REPAIR_MARKER);

    const reposDir = path.join(stateDir, "pin", "r");
    let repaired = 0;
    let scanned = 0;
    if (fs.existsSync(reposDir)) {
      for (const entry of fs.readdirSync(reposDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const cfg = path.join(reposDir, entry.name, "config.yaml");
        try {
          if (!fs.existsSync(cfg)) continue;
          scanned++;
          const next = repairEmptySyncRepoBlock(fs.readFileSync(cfg, "utf8"));
          if (next === null) continue;
          fs.writeFileSync(cfg, next, "utf8");
          repaired++;
        } catch (e) {
          log.warn("migrate", `sync_repo repair: skipped ${entry.name}: ${(e as Error).message}`);
        }
      }
    }

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
    if (repaired > 0) {
      log.info(
        "migrate",
        `sync_repo repair: restored an empty "sync_repo:" block in ${repaired}/${scanned} repo config(s) — ` +
          `those repo units could not be read at all until now.`,
      );
    }
  } catch (e) {
    log.warn("migrate", `sync_repo repair failed (continuing): ${(e as Error).message}`);
  }
}
