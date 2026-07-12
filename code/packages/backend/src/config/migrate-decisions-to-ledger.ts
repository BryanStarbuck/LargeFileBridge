// One-time, idempotent backfill of the SHARED per-file decision ledger (decisions.mdx §13).
//
// Before the shared ledger existed, per-file decisions lived ONLY in the machine-local
// `pin/r/<repo>/config.yaml → decisions:` frozen enum map ("sync"/"ignore"/"undecided"). Upgrading must
// not lose them or suddenly re-ask about everything already triaged. On first run after the upgrade, for
// each repo with a non-empty local `decisions:` map, this seeds the shared `<repo>/.lfbridge/decisions.yaml`
// from that map: "sync" → {ipfs:true}, "ignore" → {ipfs:false} (the git-ignore axis was never separately
// tracked, so it stays false). Every seeded event is stamped `decided_by:"migrated"`, `decided_at:` the
// config file's mtime (best-known time), `asked:true`.
//
// Contract (mirrors migrate-sync-to-pin.ts):
//   * Runs ONCE at startup, AFTER the sync→pin migration (it reads pin/r/<repo>/config.yaml).
//   * Idempotent: a per-repo marker file (`.decisions_migrated`) + a skip of already-"migrated" paths make
//     a re-run a no-op; a repo with no local decisions is marked done immediately.
//   * Consent-aware: only writes the shared ledger when this computer keeps `.lfbridge/` for the repo
//     (decisions.mdx §6). With consent off we DON'T mark the repo migrated, so a later run (after the user
//     grants consent) can still seed it.
//   * Never overwrites a NEWER ledger event for the same path — the fold's last-writer-wins protects any
//     hand/teammate decision made post-upgrade.
//   * Best-effort and NEVER throws: any failure is logged and swallowed so a broken migration can't crash boot.
import fs from "node:fs";
import { repoUnitDir, unitConfigPath } from "../shared/store/scopes.js";
import { listRepoFolders, getRepoConfig } from "../modules/store-model/units.service.js";
import { seedMigratedLedger } from "../modules/storage/decisions.service.js";
import { log } from "../shared/logging.js";

export async function migrateDecisionsToLedger(): Promise<void> {
  let repos = 0;
  let seeded = 0;
  try {
    for (const folder of listRepoFolders()) {
      try {
        const n = await migrateOneRepo(folder);
        if (n > 0) {
          repos++;
          seeded += n;
        }
      } catch (err) {
        log.warn("migrate", `decisions→ledger for ${folder} failed (ignored): ${errMsg(err)}`);
      }
    }
    if (seeded > 0) {
      log.info("migrate", `decisions→ledger: seeded ${seeded} decision(s) across ${repos} repo(s)`);
    }
  } catch (err) {
    // Absolute backstop — a broken migration must never crash boot.
    log.warn("migrate", `decisions→ledger migration failed (ignored): ${errMsg(err)}`);
  }
}

// Returns how many events were seeded for this repo (0 if none / already done).
async function migrateOneRepo(folder: string): Promise<number> {
  const marker = markerPath(folder);
  if (fs.existsSync(marker)) return 0; // already migrated this repo

  const cfg = getRepoConfig(folder);
  const decisions = (cfg.decisions ?? {}) as Record<string, string>;
  const hasAny = Object.values(decisions).some((v) => v === "sync" || v === "ignore");
  if (!hasAny) {
    touch(marker); // nothing to backfill — mark done so we never re-scan this repo
    return 0;
  }

  const decidedAt = configMtimeIso(folder);
  const n = await seedMigratedLedger(folder, decisions, decidedAt);
  if (n < 0) {
    // Consent off (keep-.lfbridge/ disabled): the legacy local map stays the cache and nothing is shared.
    // Do NOT mark migrated, so a later boot after the user grants consent can still seed the shared ledger.
    return 0;
  }
  touch(marker);
  if (n > 0) log.info("migrate", `decisions→ledger: seeded ${n} decision(s) for ${folder}`);
  return n;
}

function markerPath(folder: string): string {
  // Machine-local marker under the repo's state unit dir — a sibling of the pin unit's config.yaml.
  return unitConfigPath(repoUnitDir(folder)).replace(/config\.yaml$/, ".decisions_migrated");
}

function touch(file: string): void {
  try {
    fs.mkdirSync(repoUnitDirOf(file), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString() + "\n", "utf8");
  } catch (err) {
    log.warn("migrate", `decisions→ledger: could not write marker ${file} (ignored): ${errMsg(err)}`);
  }
}

function repoUnitDirOf(file: string): string {
  return file.slice(0, file.lastIndexOf("/"));
}

// The config file's mtime is the best-known "when" for a legacy decision (decisions.mdx §13); fall back to
// now if it can't be stat'd.
function configMtimeIso(folder: string): string {
  try {
    return fs.statSync(unitConfigPath(repoUnitDir(folder))).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
