// The per-file DECISION LEDGER (decisions.mdx) — the SHARED, team-visible record of what LFBridge should
// do with each large file, on TWO INDEPENDENT AXES: `ipfs` (Add to IPFS / pin) and `gitignore` (Add to
// git ignore). It lives in the repo's committed SDL at `<repo>/.lfbridge/decisions.yaml`, travels via the
// git backbone, and is UNION-MERGED so a whole team shares one set of decisions and no teammate is
// re-asked about a file another already triaged (decisions.mdx §4/§5).
//
// Like the committed manifest (manifest.service.ts), this file is TRACKED BY GIT, so it is NOT written
// through the `updated_at`-stamping yaml-store: it is serialized DETERMINISTICALLY (sorted, stable key
// order, no volatile timestamp) so an unchanged log re-serializes byte-identically, and on read it detects
// git merge-conflict markers and QUARANTINES rather than parsing a half-merged file as truth (decisions.mdx §5).
//
// It is an APPEND LOG of events folded on read: for each (sid, path) the latest `decided_at` wins
// (ties broken by `decided_by` for total determinism). An event with `asked:false` returns a file to
// Undecided. The machine-local `pin/r/<repo>/config.yaml → decisions:` frozen enum map is a RECONCILED
// PROJECTION of this ledger's IPFS axis (decisions.mdx §7) — the pin engine still reads that enum.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import { DecisionsLedgerSchema, type DecisionEvent } from "@lfb/shared";
import { LFBRIDGE_DIR, readStorageIndex } from "./tracking.service.js";
import { storageSid } from "./storage.service.js";
import { readStorageSettings } from "./storage-settings.service.js";
import { applyGitIgnore } from "../git/gitignore.service.js";
import { getRepoConfig, updateRepoConfig } from "../store-model/units.service.js";
import { log } from "../../shared/logging.js";

/** The two axes the user decides on, per file (decisions.mdx §1). Either may be undefined = "leave as-is". */
export interface DecisionAxes {
  ipfs?: boolean;
  gitignore?: boolean;
}

/** One file's CURRENT decision after folding the event log (decisions.mdx §2/§5). */
export interface FoldedDecision {
  sid: string;
  path: string;
  asked: boolean;
  ipfs: boolean;
  gitignore: boolean;
  decidedBy: string | null;
  decidedAt: string;
}

// ── paths ────────────────────────────────────────────────────────────────────

/** The absolute path to a repo's `.lfbridge/` tracking dir, honoring a relocated `.lfbridge/`
 *  (storage_settings.mdx §3) and falling back to `<root>/.lfbridge/`. */
function trackingDir(repoRoot: string): string {
  try {
    const relocated = readStorageSettings(storageSid(repoRoot)).lfbridge.path;
    if (relocated && relocated.trim()) return path.resolve(relocated);
  } catch {
    /* no per-storage settings yet → default location */
  }
  return path.join(repoRoot, LFBRIDGE_DIR);
}

function ledgerPath(repoRoot: string): string {
  return path.join(trackingDir(repoRoot), "decisions.yaml");
}

function quarantinePath(repoRoot: string): string {
  return path.join(trackingDir(repoRoot), "decisions.conflicted.yaml");
}

/** Whether THIS computer keeps `.lfbridge/` for this storage (decisions.mdx §6 consent). Default ON. */
function keepsLfbridge(repoRoot: string): boolean {
  try {
    return readStorageSettings(storageSid(repoRoot)).lfbridge.enabled;
  } catch {
    return true; // documented default: keep .lfbridge/ and share decisions
  }
}

// ── read / fold / write ────────────────────────────────────────────────────

function hasConflictMarkers(raw: string): boolean {
  return /^(<{7}|={7}|>{7})(\s|$)/m.test(raw);
}

/** Read the committed event log a `git pull` delivered. Missing → empty; conflict markers → quarantine &
 *  refuse (never parse a half-merged file as truth). */
export function readLedger(repoRoot: string): DecisionEvent[] {
  const file = ledgerPath(repoRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("decisions", `read failed (using empty): ${file}: ${(e as Error).message}`);
    }
    return [];
  }
  if (hasConflictMarkers(raw)) {
    try {
      fs.copyFileSync(file, quarantinePath(repoRoot));
    } catch (e) {
      log.warn("decisions", `quarantine copy failed: ${(e as Error).message}`);
    }
    log.error(
      "decisions",
      `${file}: git merge-conflict markers detected — REFUSING to load; quarantined to ${quarantinePath(repoRoot)}`,
    );
    throw new Error(`Merge conflict in decision ledger at ${file} (quarantined, not loaded)`);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (e) {
    log.error("decisions", `YAML parse failed: ${file}: ${(e as Error).message}`);
    throw new Error(`Corrupt decision ledger at ${file}`);
  }
  const result = DecisionsLedgerSchema.safeParse(parsed);
  if (!result.success) {
    log.error("decisions", `Schema validation failed: ${file}: ${result.error.message}`);
    throw new Error(`Invalid decision ledger at ${file}`);
  }
  return result.data.events;
}

/**
 * Fold the (merged) event log to current per-file state (decisions.mdx §5): for each (sid, path) the
 * latest `decided_at` wins; ties break by `decided_by` lexical order so every machine folds identically.
 */
export function foldLedger(events: DecisionEvent[]): Map<string, FoldedDecision> {
  const latest = new Map<string, DecisionEvent>();
  for (const e of events) {
    const key = e.path; // fold by PATH ALONE (ledger is per-storage); sid is provenance, NOT a fold key
    const prev = latest.get(key);
    if (
      !prev ||
      e.decided_at > prev.decided_at ||
      (e.decided_at === prev.decided_at && (e.decided_by ?? "") > (prev.decided_by ?? ""))
    ) {
      latest.set(key, e);
    }
  }
  const folded = new Map<string, FoldedDecision>();
  for (const e of latest.values()) {
    folded.set(e.path, {
      sid: e.sid,
      path: e.path,
      asked: e.asked,
      ipfs: e.ipfs,
      gitignore: e.gitignore,
      decidedBy: e.decided_by,
      decidedAt: e.decided_at,
    });
  }
  return folded;
}

/**
 * Write the event log DETERMINISTICALLY (sorted by decided_at, then sid, then path — no volatile fields
 * beyond the recorded timestamps) and ATOMICALLY (temp → fsync → rename). Appending a new event only adds
 * lines, so a union-merge of two divergent logs keeps both sides (decisions.mdx §5).
 */
function writeLedger(repoRoot: string, events: DecisionEvent[]): void {
  const dir = trackingDir(repoRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  const sorted = [...events].sort(
    (a, b) =>
      a.decided_at.localeCompare(b.decided_at) ||
      a.sid.localeCompare(b.sid) ||
      a.path.localeCompare(b.path) ||
      (a.decided_by ?? "").localeCompare(b.decided_by ?? ""),
  );
  const body = YAML.stringify({ schema_version: 1, events: sorted });
  const file = ledgerPath(repoRoot);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    log.error("decisions", `write failed: ${file}: ${(e as Error).message}`);
    throw e;
  }
}

/** Append events to the shared ledger (read → concat → deterministic write). */
function appendEvents(repoRoot: string, events: DecisionEvent[]): void {
  const existing = readLedger(repoRoot);
  writeLedger(repoRoot, [...existing, ...events]);
}

// ── record + reconcile (the write path every decision surface funnels through) ──

/** repo-root absolute path for a state-root folder key. */
function repoRootFor(folder: string): string {
  const p = getRepoConfig(folder).repo.path;
  if (!p) throw new Error(`repo ${folder} has no path`);
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/**
 * The STABLE, team-shared Storage ID stamped on each decision record (decisions.mdx §3.1). It must be
 * IDENTICAL for every teammate/computer of the same repo, so it is derived from the SHARED git remote URL
 * when there is one (`repo.remote`) — NOT from the per-machine local path (`storageSid()` = shortHash of
 * the root, which differs on every computer). Falls back to the local storage id only when the repo has no
 * remote (a purely local repo, whose decisions don't travel anyway). The `sid` is provenance/portability
 * metadata, not a fold key (foldLedger keys on path alone) — but keeping it stable makes the same logical
 * storage identifiable across machines and in any aggregated/quarantined view.
 */
function decisionSid(folder: string, repoRoot: string): string {
  const remote = getRepoConfig(folder).repo.remote;
  if (remote && remote.trim()) {
    return "r:" + crypto.createHash("sha1").update(remote.trim()).digest("hex").slice(0, 12);
  }
  return storageSid(repoRoot);
}

/**
 * Record a two-axis decision for one or many repo-RELATIVE paths (decisions.mdx §3/§8). Stamps
 * asked/ipfs/gitignore + decided_by + decided_at + the Storage ID, writes the SHARED ledger when this
 * computer keeps `.lfbridge/` (else local-only, decisions.mdx §6), applies the git-ignore axis through
 * the engine, and reconciles the machine-local frozen enum cache.
 *
 * `asked:false` on a path returns it to Undecided (a tombstone event) — used by "Set to Undecided".
 */
export async function recordDecision(
  folder: string,
  relPaths: string[],
  axes: DecisionAxes,
  decidedBy: string | null,
  opts: { asked?: boolean } = {},
): Promise<void> {
  const repoRoot = repoRootFor(folder);
  const asked = opts.asked !== false;
  const sid = decisionSid(folder, repoRoot); // STABLE across the team (remote-derived), not per-machine
  const decidedAt = new Date().toISOString();

  // Fingerprints from the tracking index (advisory identity; absent files simply have null).
  const fpByPath = new Map<string, string | null>();
  try {
    for (const row of readStorageIndex(repoRoot)) fpByPath.set(row.path, row.fingerprint);
  } catch {
    /* no index yet → fingerprints stay null */
  }

  const events: DecisionEvent[] = relPaths.map((p) => ({
    sid,
    path: p,
    fingerprint: fpByPath.get(p) ?? null,
    asked, // asked:false is a TOMBSTONE that returns the file to Undecided (decisions.mdx §2)
    ipfs: !!axes.ipfs,
    gitignore: !!axes.gitignore,
    decided_by: decidedBy,
    decided_at: decidedAt,
  }));

  // The SHARED write is gated on the machine-local keep-.lfbridge consent (decisions.mdx §6).
  if (keepsLfbridge(repoRoot)) {
    // Append the events (decisions AND tombstones) to the team-shared ledger, then reconcile — the fold
    // projects the ledger onto the local frozen enum, so a tombstone (asked:false) correctly un-decides.
    try {
      appendEvents(repoRoot, events);
    } catch (e) {
      log.error("decisions", `${repoRoot}: shared ledger append failed: ${(e as Error).message}`);
      throw e;
    }
    await reconcile(folder);
  } else {
    // Consent OFF (rare): do NOT touch the repo root. Remember the decision LOCALLY ONLY so this computer
    // never re-asks; it is simply not shared to the team from this machine (decisions.mdx §6). Skip
    // reconcile so a teammate's shared ledger doesn't overwrite this local-only choice.
    await updateRepoConfig(folder, (c) => {
      for (const p of relPaths) {
        if (!asked) delete c.decisions[p];
        else c.decisions[p] = axes.ipfs ? "sync" : "ignore";
      }
      return c;
    });
  }

  // Apply the git-ignore axis through the engine (anchored, idempotent, skip-already-ignored) only when
  // the user turned it ON — we never git-ignore on our own (charter / git_ignore.mdx). Independent of the
  // ledger vs. local-only branch above.
  if (asked && axes.gitignore) {
    const abs = relPaths.map((p) => path.join(repoRoot, p));
    try {
      applyGitIgnore({ paths: abs, recursive: false });
    } catch (e) {
      log.warn("decisions", `${repoRoot}: git-ignore apply failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Project the folded ledger onto the machine-local frozen `decisions:` enum map — the IPFS axis only
 * (decisions.mdx §7). `ipfs:true → "sync"`, `ipfs:false → "ignore"`, `asked:false → remove` (undecided).
 * The pin engine reads this enum; the `sync` literal is never renamed. Non-ledger paths are left as-is.
 */
export async function reconcile(folder: string): Promise<void> {
  const repoRoot = repoRootFor(folder);
  let folded: Map<string, FoldedDecision>;
  try {
    folded = foldLedger(readLedger(repoRoot));
  } catch (e) {
    log.warn("decisions", `${repoRoot}: reconcile skipped (ledger unreadable): ${(e as Error).message}`);
    return;
  }
  await updateRepoConfig(folder, (c) => {
    for (const rec of folded.values()) {
      if (!rec.asked) delete c.decisions[rec.path];
      else c.decisions[rec.path] = rec.ipfs ? "sync" : "ignore";
    }
    return c;
  });
}
