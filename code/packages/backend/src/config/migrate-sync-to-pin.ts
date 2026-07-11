// One-time "sync" → "pin" compatibility migration (see RENAME_SPEC "sync → pin").
//
// The app renamed its every-15-min "sync" pass to "pin". Existing installs have
// on-disk state (state root under ~/T/_large_files_bridge/) written the OLD way.
// This migration upgrades that persisted local state in place — directory names,
// app config block, per-unit config/status keys, and the stale launchd agent —
// so nothing is orphaned once the code stops reading the old names.
//
// Contract:
//   * Runs ONCE at startup, BEFORE config is first read.
//   * Idempotent: every step detects an already-migrated (or absent) state and
//     skips, so re-running is a no-op.
//   * Best-effort and NEVER throws: any failure is logged and swallowed so a
//     broken migration can never crash boot.
//
// NOTE on the FROZEN wire format: the `decisions:` map values ("sync"/"ignore"/
// "undecided") are a frozen on-disk/wire contract and MUST NOT be renamed here.
// We only rename local structural keys (synced→pinned, sync:→pin:, last_sync_at
// →last_pin_at) and the local state-root dir (sync/→pin/).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { log } from "../shared/logging.js";

const OLD_LAUNCHD_LABEL = "com.largefilebridge.sync";
const NEW_LAUNCHD_LABEL = "com.largefilebridge.pin";

export function migrateSyncToPin(stateDir: string): void {
  try {
    let dirRenamed = false;
    let unitFilesUpdated = 0;
    let appConfigUpdated = false;
    let launchdCleaned = false;

    // Step 1 — rename the local state-root dir sync/ → pin/.
    dirRenamed = renameSyncDir(stateDir);

    // Step 2 — app config.yaml: sync_process → pin_process.
    appConfigUpdated = migrateAppConfig(stateDir);

    // Steps 3 & 4 — per-unit config.yaml / status.yaml under pin/.
    unitFilesUpdated = migrateUnitFiles(stateDir);

    // Step 5 — remove the stale launchd LaunchAgent (macOS only).
    launchdCleaned = cleanLaunchd();

    if (dirRenamed || appConfigUpdated || unitFilesUpdated > 0 || launchdCleaned) {
      log.info(
        "migrate",
        `sync→pin migration: dir ${dirRenamed ? "renamed" : "unchanged"}, ` +
          `app config ${appConfigUpdated ? "updated" : "unchanged"}, ` +
          `${unitFilesUpdated} unit file(s) updated, ` +
          `launchd ${launchdCleaned ? "cleaned" : "unchanged"}`,
      );
    } else {
      log.info("migrate", "nothing to migrate");
    }
  } catch (err) {
    // Absolute backstop — a broken migration must never crash boot.
    log.warn("migrate", `sync→pin migration failed (ignored): ${errMsg(err)}`);
  }
}

// Step 1: if <stateDir>/sync exists AND <stateDir>/pin does NOT, rename it.
// If both exist, leave as-is and log (never merge). Best-effort.
function renameSyncDir(stateDir: string): boolean {
  const syncDir = path.join(stateDir, "sync");
  const pinDir = path.join(stateDir, "pin");
  try {
    if (!dirExists(syncDir)) return false;
    if (dirExists(pinDir)) {
      log.warn(
        "migrate",
        `both 'sync' and 'pin' state dirs exist under ${stateDir}; leaving as-is (no merge)`,
      );
      return false;
    }
    fs.renameSync(syncDir, pinDir);
    log.info("migrate", `renamed state dir ${syncDir} → ${pinDir}`);
    return true;
  } catch (err) {
    log.warn("migrate", `failed to rename sync→pin state dir (ignored): ${errMsg(err)}`);
    return false;
  }
}

// Step 2: app config.yaml — sync_process → pin_process, remap default label.
function migrateAppConfig(stateDir: string): boolean {
  const file = path.join(stateDir, "config.yaml");
  try {
    const obj = readYaml(file);
    if (!isRecord(obj)) return false;
    if (!("sync_process" in obj) || "pin_process" in obj) return false;

    const block = obj.sync_process;
    obj.pin_process = block;
    if (
      isRecord(block) &&
      block.label === OLD_LAUNCHD_LABEL
    ) {
      block.label = NEW_LAUNCHD_LABEL;
    }
    delete obj.sync_process;

    writeYaml(file, obj);
    log.info("migrate", `app config: sync_process → pin_process (${file})`);
    return true;
  } catch (err) {
    log.warn("migrate", `failed to migrate app config (ignored): ${errMsg(err)}`);
    return false;
  }
}

// Steps 3 & 4: walk the fixed one-level-deep unit layout under pin/ and
// migrate each config.yaml + status.yaml. Returns count of files changed.
function migrateUnitFiles(stateDir: string): number {
  const pinDir = path.join(stateDir, "pin");
  let updated = 0;
  for (const unitDir of unitDirs(pinDir)) {
    updated += migrateUnitConfig(path.join(unitDir, "config.yaml"));
    updated += migrateUnitStatus(path.join(unitDir, "status.yaml"));
  }
  return updated;
}

// Enumerate the fixed unit dirs: pin/computer, pin/r/*, pin/s/*, pin/c/*.
// Only one level of fan-out under r/s/c — no arbitrary recursion. Tolerates
// missing dirs.
function unitDirs(pinDir: string): string[] {
  const dirs: string[] = [];
  const computer = path.join(pinDir, "computer");
  if (dirExists(computer)) dirs.push(computer);
  for (const bucket of ["r", "s", "c"]) {
    const bucketDir = path.join(pinDir, bucket);
    for (const child of listDirs(bucketDir)) {
      dirs.push(path.join(bucketDir, child));
    }
  }
  return dirs;
}

// Step 3: unit config.yaml — synced → pinned, sync: → pin:. Leave decisions frozen.
function migrateUnitConfig(file: string): number {
  try {
    const obj = readYaml(file);
    if (!isRecord(obj)) return 0;

    let changed = false;
    if ("synced" in obj && !("pinned" in obj)) {
      obj.pinned = obj.synced;
      delete obj.synced;
      changed = true;
    }
    if ("sync" in obj && !("pin" in obj)) {
      obj.pin = obj.sync;
      delete obj.sync;
      changed = true;
    }
    // NB: obj.decisions and its "sync" VALUES are the frozen wire format — untouched.

    if (!changed) return 0;
    writeYaml(file, obj);
    log.info("migrate", `unit config migrated: ${file}`);
    return 1;
  } catch (err) {
    log.warn("migrate", `failed to migrate unit config ${file} (ignored): ${errMsg(err)}`);
    return 0;
  }
}

// Step 4: unit status.yaml — last_sync_at → last_pin_at.
function migrateUnitStatus(file: string): number {
  try {
    const obj = readYaml(file);
    if (!isRecord(obj)) return 0;

    if (!("last_sync_at" in obj) || "last_pin_at" in obj) return 0;
    obj.last_pin_at = obj.last_sync_at;
    delete obj.last_sync_at;

    writeYaml(file, obj);
    log.info("migrate", `unit status migrated: ${file}`);
    return 1;
  } catch (err) {
    log.warn("migrate", `failed to migrate unit status ${file} (ignored): ${errMsg(err)}`);
    return 0;
  }
}

// Step 5: remove the stale launchd LaunchAgent so it stops firing a now-gone
// worker. macOS only. Do NOT install the new agent — the scheduler bootstrap
// installs com.largefilebridge.pin when the user has it enabled.
function cleanLaunchd(): boolean {
  if (process.platform !== "darwin") return false;
  let didSomething = false;

  const uid = process.getuid?.() ?? 501;
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${OLD_LAUNCHD_LABEL}`]);
    didSomething = true;
  } catch {
    // Not loaded (or already booted out) — expected on already-migrated installs. Ignore.
  }

  const plist = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${OLD_LAUNCHD_LABEL}.plist`,
  );
  try {
    if (fs.existsSync(plist)) {
      fs.rmSync(plist, { force: true });
      log.info("migrate", `removed stale LaunchAgent plist ${plist}`);
      didSomething = true;
    }
  } catch (err) {
    log.warn("migrate", `failed to remove stale LaunchAgent plist (ignored): ${errMsg(err)}`);
  }

  return didSomething;
}

// ── small helpers ──────────────────────────────────────────────────────────

function readYaml(file: string): unknown {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  return parse(text);
}

function writeYaml(file: string, obj: unknown): void {
  fs.writeFileSync(file, stringify(obj), "utf8");
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// List immediate child directory names of `dir`; [] if missing.
function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
