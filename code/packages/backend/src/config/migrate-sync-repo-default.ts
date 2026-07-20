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

/** Strip a `sync_repo: { enabled: false }` block's `enabled` line, leaving the block (and everything else)
 *  intact. Returns the new text, or null when there is nothing to change. */
export function clearPersistedSyncRepoFalse(yaml: string): string | null {
  const lines = yaml.split("\n");
  let inBlock = false;
  let changed = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^sync_repo:\s*$/.test(line)) {
      inBlock = true;
      out.push(line);
      continue;
    }
    if (inBlock) {
      // Still inside the block only while lines are indented; the next top-level key ends it.
      if (/^\s+/.test(line)) {
        if (/^\s+enabled:\s*false\s*$/.test(line)) {
          changed = true; // drop this line — absent means "the default", which is ON
          continue;
        }
      } else {
        inBlock = false;
      }
    }
    out.push(line);
  }
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
