// The per-file DECISION LEDGER (decisions.mdx) — the SHARED, team-visible record of what LFBridge should
// do with each large file, on TWO INDEPENDENT AXES: `ipfs` (Add to IPFS / pin) and `gitignore` (Add to
// git ignore). It is Category-B tracking state, so it lives in LOCAL STORAGE at
// `~/T/_large_files_bridge/repos/<repoKey>/decisions.yaml` (resolveTrackingRoot) — NEVER inside a working
// repo, so it can no longer merge-conflict there. It still travels to the team and is UNION-MERGED, but the
// travelling vehicle is now the owning company/Personal SYNC REPO (`<syncRepo>/repos/<repoKey>/
// decisions.yaml`), mirrored additively when one is configured — not the working repo's git
// (artifact_placement_policy.mdx §4/§5). Absent a sync repo it is honored locally, simply not yet shared.
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
import {
  DecisionsLedgerSchema,
  DecisionPolicyDocSchema,
  type DecisionEvent,
  type DecisionPolicyDoc,
} from "@lfb/shared";
import { readStorageIndex } from "./tracking.service.js";
import { resolveTrackingRoot } from "./tracking-root.service.js";
import { mirrorToSyncRepo } from "./tracking-sync.service.js";
import { storageSid } from "./storage.service.js";
import { readStorageSettings } from "./storage-settings.service.js";
import { applyGitIgnore, unignorePaths } from "../git/gitignore.service.js";
import { classifyRemoteVisibility } from "../git/git.service.js";
import { classifySpecial } from "../scanner/special-file.service.js";
import { effectiveFlags, getAppConfig } from "../store-model/config.service.js";
import { repoUnitDir, unitConfigPath } from "../../shared/store/scopes.js";
import { getRepoConfig, updateRepoConfig, repoBumpTopics } from "../store-model/units.service.js";
import { bumpTopics, bumpTopicsThrottled } from "../events/state-events.service.js";
import { resolveStateDir } from "../../config/state-dir.js";
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

/** The Local-Storage tracking dir for this repo (`~/T/_large_files_bridge/repos/<repoKey>/`) where the
 *  decision ledger lives — never a working repo (artifact_placement_policy.mdx §2). */
function trackingDir(repoRoot: string): string {
  return resolveTrackingRoot(repoRoot);
}

function ledgerPath(repoRoot: string): string {
  return path.join(trackingDir(repoRoot), "decisions.yaml");
}

function quarantinePath(repoRoot: string): string {
  return path.join(trackingDir(repoRoot), "decisions.conflicted.yaml");
}

/** The SHARED, per-repo default-decision + attribution policy, a sibling of the ledger (decisions.mdx §9/§14). */
function policyPath(repoRoot: string): string {
  return path.join(trackingDir(repoRoot), "decisions_policy.yaml");
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
  // Additive: carry the ledger to the company/Personal sync repo when configured (default off → no-op).
  mirrorToSyncRepo(repoRoot);
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
  opts: { asked?: boolean; unignore?: boolean } = {},
): Promise<void> {
  const repoRoot = repoRootFor(folder);
  const asked = opts.asked !== false;
  const sid = decisionSid(folder, repoRoot); // STABLE across the team (remote-derived), not per-machine
  const decidedAt = new Date().toISOString();

  // Attribution (decisions.mdx §14): when the caller passed a RAW email (the common path — the router hands
  // us the authenticated session email), resolve it through the repo's attribution mode so a public repo
  // records an opaque `handle` (or `anonymous` → null) instead of leaking the raw email into committed git
  // history. Non-email decidedBy values ("migrated", "policy:…", "moved:…", null) are already the value to
  // stamp and pass through untouched.
  const stampedBy = decidedBy && isPlainEmail(decidedBy) ? await attributionFor(folder, decidedBy) : decidedBy;

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
    decided_by: stampedBy,
    decided_at: decidedAt,
  }));

  // The ledger is ALWAYS written — to Local Storage, unconditionally (decisions.mdx §6, LOCKED). It never
  // touches the working repo, so the keep-`.lfbridge/` consent (which now governs only Category-A content
  // artifacts) has nothing to gate here; whether the events TRAVEL is governed by the sync repo alone
  // (`mirrorToSyncRepo` no-ops when none is configured). The old consent gate wrote the frozen cache with
  // NO ledger event — a decision honored on this machine that no other computer could ever learn, the
  // cache-only shape behind the 2026-07-20 "not backed up: 22 / 0" defect.
  // Append the events (decisions AND tombstones) to the team-shared ledger, then reconcile — the fold
  // projects the ledger onto the local frozen enum, so a tombstone (asked:false) correctly un-decides.
  try {
    appendEvents(repoRoot, events);
  } catch (e) {
    log.error("decisions", `${repoRoot}: shared ledger append failed: ${(e as Error).message}`);
    throw e;
  }
  await reconcile(folder);

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

  // The OFF direction (git_ignore.mdx §5.5) — un-ignore, gated on `opts.unignore`. The charter's "never
  // git-ignore a file on our own" cuts BOTH ways: editing a user's `.gitignore` must follow an explicit
  // click, so ONLY the user-facing toggle path opts in. Policy/auto/rename writes carry gitignore:false
  // routinely and must NEVER silently un-ignore a file as a side effect.
  if (asked && opts.unignore && axes.gitignore === false) {
    const abs = relPaths.map((p) => path.join(repoRoot, p));
    try {
      const refused = unignorePaths(abs).filter((o) => !o.removed && o.refusal !== "not-ignored");
      for (const o of refused) {
        log.info(
          "decisions",
          `${repoRoot}: kept git-ignore for ${path.relative(repoRoot, o.path)} (${o.refusal}` +
            `${o.rule ? ` — ${o.rule.source}:${o.rule.line} '${o.rule.pattern}'` : ""})`,
        );
      }
    } catch (e) {
      log.warn("decisions", `${repoRoot}: git-ignore removal failed: ${(e as Error).message}`);
    }
  }

  // The local decision write is a state change an already-open page must learn about (performance.mdx
  // Aspect 6b) — the receiving side (reconcile after a backbone pull) bumps, and so must this side.
  bumpTopics(repoBumpTopics(folder));
}

/**
 * Project the folded ledger onto the machine-local frozen `decisions:` enum map — the IPFS axis only
 * (decisions.mdx §7). `ipfs:true → "sync"`, `ipfs:false → "ignore"`, `asked:false → remove` (undecided).
 * The pin engine reads this enum; the `sync` literal is never renamed. Non-ledger paths are left as-is.
 */
export async function reconcile(folder: string): Promise<{ changed: string[] }> {
  const repoRoot = repoRootFor(folder);
  let folded: Map<string, FoldedDecision>;
  try {
    folded = foldLedger(readLedger(repoRoot));
  } catch (e) {
    log.warn("decisions", `${repoRoot}: reconcile skipped (ledger unreadable): ${(e as Error).message}`);
    return { changed: [] };
  }
  // ── BACKFILL cache-only decisions into the ledger (decisions.mdx §13, as a STANDING guard) ──────────
  // A frozen-enum entry with NO ledger event AT ALL (not even a tombstone) has no vehicle to travel: the
  // pin engine honors it here forever while the user's other computers can never learn it — the exact
  // shape behind "not backed up: 22 on the tower, 0 on the laptop" (2026-07-20 charlie-kirk): the one-time
  // §13 migration HAD seeded these events on Jul 12, then the old wholesale mirror copy erased them, and
  // the migration's marker meant nothing would ever re-seed. The guard therefore lives HERE, on every
  // reconcile, not behind a run-once marker — idempotent because once written, the fold sees the events.
  // Stamps per §13: `decided_by:"migrated"`, `decided_at:` the config file's mtime (best-known time, and
  // deliberately OLD so any real teammate event for the same path wins the last-writer fold).
  try {
    const cacheOnly = Object.entries(getRepoConfig(folder).decisions).filter(([p]) => !folded.has(p));
    if (cacheOnly.length > 0) {
      const sid = decisionSid(folder, repoRoot);
      let decidedAt: string;
      try {
        decidedAt = fs.statSync(unitConfigPath(repoUnitDir(folder))).mtime.toISOString();
      } catch {
        decidedAt = new Date().toISOString();
      }
      const events: DecisionEvent[] = cacheOnly.map(([p, d]) => ({
        sid,
        path: p,
        fingerprint: null,
        asked: true,
        ipfs: d === "sync",
        // Provenance-only here: the ⊘ axis reads git reality, never the ledger (decisions.mdx §1.1),
        // and a backfill must not claim a git-ignore intent nobody expressed.
        gitignore: false,
        decided_by: "migrated",
        decided_at: decidedAt,
      }));
      appendEvents(repoRoot, events);
      for (const e of events) {
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
      log.info("decisions", `${repoRoot}: backfilled ${events.length} cache-only decision(s) into the shared ledger`);
    }
  } catch (e) {
    log.warn("decisions", `${repoRoot}: cache-only decision backfill failed: ${(e as Error).message}`);
  }
  // Track which paths' projected IPFS-axis enum FLIPS vs. the previous local value (decisions.mdx §11) —
  // the caller (pin pass) uses this to surface the quiet "N decisions changed by teammates" dock note.
  const changed: string[] = [];
  await updateRepoConfig(folder, (c) => {
    changed.length = 0; // reset in case updateYaml re-runs this mutator (read-modify-write retry)
    for (const rec of folded.values()) {
      const prev = c.decisions[rec.path]; // "sync" | "ignore" | undefined (undecided)
      const next = !rec.asked ? undefined : rec.ipfs ? "sync" : "ignore";
      if (prev !== next) changed.push(rec.path);
      if (next === undefined) delete c.decisions[rec.path];
      else c.decisions[rec.path] = next;
    }
    return c;
  });
  // Teammates' folded decisions just landed. Throttled: the pin pass reconciles every repo in a burst,
  // and the shared `repos` topic must not fire once per repo (performance.mdx Aspect 6b flood rule).
  if (changed.length > 0) bumpTopicsThrottled(repoBumpTopics(folder));
  return { changed };
}

// ── §9 default-decision policy (read / write / apply) ────────────────────────

/**
 * Read the SHARED, per-repo default-decision + attribution policy (decisions.mdx §9/§14) from
 * `<repo>/.lfbridge/decisions_policy.yaml`. Missing / unreadable / invalid → the schema DEFAULT, whose
 * "default of the default" is OFF (media & other both `mode:"ask"`) so new files stay Undecided until a
 * team deliberately opts into auto-decide.
 */
export function readDecisionPolicy(folder: string): DecisionPolicyDoc {
  const repoRoot = repoRootFor(folder);
  const file = policyPath(repoRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("decisions", `policy read failed (using default): ${file}: ${(e as Error).message}`);
    }
    return DecisionPolicyDocSchema.parse({});
  }
  try {
    const parsed = DecisionPolicyDocSchema.safeParse(YAML.parse(raw) ?? {});
    if (parsed.success) return parsed.data;
    log.warn("decisions", `policy invalid (using default): ${file}: ${parsed.error.message}`);
  } catch (e) {
    log.warn("decisions", `policy parse failed (using default): ${file}: ${(e as Error).message}`);
  }
  return DecisionPolicyDocSchema.parse({});
}

/** Deterministic + atomic write of the policy doc (same discipline as the ledger — temp → fsync → rename). */
function writeDecisionPolicy(repoRoot: string, doc: DecisionPolicyDoc): void {
  const dir = trackingDir(repoRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  const body = YAML.stringify(doc);
  const file = policyPath(repoRoot);
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
    log.error("decisions", `policy write failed: ${file}: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * Merge `patch` into the shared policy, stamp `set_at`, validate, and persist (decisions.mdx §9). Changing
 * the policy is itself an audited decision. The shared write is gated on the machine-local keep-`.lfbridge/`
 * consent (§6): with consent OFF we do not touch the repo root — we log and return the merged doc so the
 * caller still sees the intended state.
 */
export function setDecisionPolicy(folder: string, patch: Partial<DecisionPolicyDoc>): DecisionPolicyDoc {
  const repoRoot = repoRootFor(folder);
  const current = readDecisionPolicy(folder);
  const merged = DecisionPolicyDocSchema.parse({
    ...current,
    ...patch,
    set_at: new Date().toISOString(),
  });
  if (keepsLfbridge(repoRoot)) {
    writeDecisionPolicy(repoRoot, merged);
  } else {
    log.info("decisions", `${repoRoot}: policy not shared (keep-.lfbridge consent off); kept in memory only`);
  }
  bumpTopics(repoBumpTopics(folder));
  return merged;
}

/**
 * Build the cheap classifier context (special_files.mdx) — only the big-file threshold is needed here; the
 * git-ignore / forced / pinned predicates are irrelevant to distinguishing media (video/image) from other
 * kinds, which is all the policy branch needs.
 */
function policyClassifyCtx() {
  return { thresholdBytes: getAppConfig().big_file.threshold_bytes };
}

/**
 * Apply the shared default-decision policy (decisions.mdx §9) to newly-discovered candidate paths that have
 * NO folded decision record yet. For each such path we classify it (video/image → the `media` policy; else
 * → the `other` policy). When that kind's mode is `"auto"` we auto-decide it: record a real, attributed
 * ledger event (`decided_by: "policy:<set_by>"`, `asked:true`) so the file is born Decided and never enters
 * the triage queue — honoring the sticky **Never IPFS** flag (§17: a flagged file gets `ipfs:false`, only
 * the git-ignore axis of the policy is applied). Kinds in `"ask"` mode are left Undecided (surfaced).
 * Returns a count for the pass summary ("N new files auto-decided by policy").
 */
export async function applyDefaultPolicy(
  folder: string,
  newPaths: string[],
): Promise<{ autoDecided: number }> {
  const repoRoot = repoRootFor(folder);
  const policy = readDecisionPolicy(folder);

  // Nothing to do unless at least one kind is on auto — cheap early out.
  if (policy.media.mode !== "auto" && policy.other.mode !== "auto") return { autoDecided: 0 };

  const decided = new Set(foldLedger(readLedger(repoRoot)).keys());
  const ctx = policyClassifyCtx();
  const setBy = policy.set_by ?? "unknown";
  const decidedBy = `policy:${setBy}`;

  // Group by resolved axes so we funnel through recordDecision a bounded number of times (not once per
  // path). Key = `${ipfs}|${gitignore}`; all share the one `policy:<set_by>` attribution.
  const groups = new Map<string, { ipfs: boolean; gitignore: boolean; paths: string[] }>();
  for (const rel of newPaths) {
    if (decided.has(rel)) continue; // already has a record (hand/teammate/prior policy) — never re-decide
    const cls = classifySpecial({ path: rel, size: 0 }, ctx);
    const isMedia = cls.categories.includes("video") || cls.categories.includes("image");
    const kind = isMedia ? policy.media : policy.other;
    if (kind.mode !== "auto") continue; // "ask" → leave Undecided (surfaced by the warning)

    // Never-IPFS is the standing exception the policy must honor (§17): force the IPFS axis off; the
    // git-ignore axis still applies. effectiveFlags walks this path + its ancestors.
    const neverIpfs = effectiveFlags(path.join(repoRoot, rel)).neverIpfs;
    const ipfs = neverIpfs ? false : kind.ipfs;
    const gitignore = kind.gitignore;

    const key = `${ipfs}|${gitignore}`;
    const g = groups.get(key) ?? { ipfs, gitignore, paths: [] };
    g.paths.push(rel);
    groups.set(key, g);
  }

  let autoDecided = 0;
  for (const g of groups.values()) {
    await recordDecision(folder, g.paths, { ipfs: g.ipfs, gitignore: g.gitignore }, decidedBy, {
      asked: true,
    });
    autoDecided += g.paths.length;
  }
  if (autoDecided > 0) {
    log.info("decisions", `${repoRoot}: ${autoDecided} new file(s) auto-decided by policy (${decidedBy})`);
  }
  return { autoDecided };
}

// ── §14 attribution (email / handle / anonymous) + machine-local handle map ──

/** A bare allow-listed email — resolvable through attribution. Anything with a `:` prefix ("policy:…",
 *  "moved:…", "migrated") is already the value to stamp and must NOT be treated as an email. */
function isPlainEmail(s: string): boolean {
  return /^[^\s:]+@[^\s:]+$/.test(s);
}

/**
 * Resolve the value to stamp as `decided_by` for a given authenticated email, per the repo's attribution
 * mode (decisions.mdx §14):
 *   • "email"     → the raw email (full attribution — private teams).
 *   • "handle"    → a STABLE OPAQUE id (salted hash of the email); the email↔handle map is kept
 *                   MACHINE-LOCAL under the state dir and never committed.
 *   • "anonymous" → null (only THAT a decision was made, not by whom).
 *   • null (auto) → resolve from the remote: a PUBLIC remote defaults to "handle" (don't leak emails into
 *                   public git history), otherwise "email".
 */
export async function attributionFor(folder: string, email: string): Promise<string | null> {
  let mode = readDecisionPolicy(folder).attribution; // "email" | "handle" | "anonymous" | null
  if (mode === null) {
    const remote = getRepoConfig(folder).repo.remote;
    mode = classifyRemoteVisibility(remote ?? null) === "public" ? "handle" : "email";
  }
  if (mode === "anonymous") return null;
  if (mode === "handle") return resolveHandle(email);
  return email; // "email"
}

// The machine-local, NEVER-committed email↔handle map (decisions.mdx §14). Lives under the state root so it
// travels with THIS computer only; teammates who want to de-opaque a handle must share this file out-of-band.
const HANDLE_MAP_FILE = () => path.join(resolveStateDir(), "decision_handles.yaml");

interface HandleMap {
  salt: string;
  handles: Record<string, string>; // email → handle
}

function readHandleMap(): HandleMap {
  try {
    const raw = fs.readFileSync(HANDLE_MAP_FILE(), "utf8");
    const parsed = YAML.parse(raw) as Partial<HandleMap> | null;
    if (parsed && typeof parsed.salt === "string" && parsed.salt) {
      return { salt: parsed.salt, handles: parsed.handles ?? {} };
    }
  } catch {
    /* missing/corrupt → mint a fresh salted map below */
  }
  return { salt: crypto.randomBytes(16).toString("hex"), handles: {} };
}

/** Deterministic (salt+email) stable handle; persist the reverse mapping machine-locally for de-opaquing. */
function resolveHandle(email: string): string {
  const map = readHandleMap();
  const existing = map.handles[email];
  if (existing) return existing;
  const handle = "u_" + crypto.createHash("sha256").update(map.salt + "\0" + email).digest("hex").slice(0, 12);
  map.handles[email] = handle;
  try {
    fs.mkdirSync(path.dirname(HANDLE_MAP_FILE()), { recursive: true });
    fs.writeFileSync(HANDLE_MAP_FILE(), YAML.stringify(map), "utf8");
  } catch (e) {
    // Non-fatal: the handle is deterministic from (salt+email), so a failed persist only loses the reverse
    // lookup convenience, not correctness — the SAME salt yields the SAME handle next time it loads.
    log.warn("decisions", `handle map persist failed (ignored): ${(e as Error).message}`);
  }
  return handle;
}

// ── §15 share status ─────────────────────────────────────────────────────────

/**
 * Whether decisions made in this repo actually reach a team (decisions.mdx §15). Consent OFF short-circuits
 * (the ledger isn't even written here); otherwise a repo with no git remote is committed-but-never-pushed.
 *   • "local_only_consent_off" — keep-`.lfbridge/` is off on this computer (§6): recorded machine-locally only.
 *   • "local_only_no_remote"   — no git remote/backbone (§15): committed but nothing pushes it to teammates.
 *   • "shared"                 — consent on AND a remote exists: decisions travel on the pin pass.
 */
export function shareStatus(
  folder: string,
): "shared" | "local_only_no_remote" | "local_only_consent_off" {
  const repoRoot = repoRootFor(folder);
  if (!keepsLfbridge(repoRoot)) return "local_only_consent_off";
  const remote = getRepoConfig(folder).repo.remote;
  if (!remote || !remote.trim()) return "local_only_no_remote";
  return "shared";
}

// ── §12 lifecycle helpers (rename / compress-convert / delete) ───────────────
// Best-effort; exported for the scanner + compress/convert flows to wire (that wiring is another agent's job).

/**
 * Carry a decision across a RENAME/move (decisions.mdx §12). The fold key is `path`, so a bare rename would
 * read as "old decided, new undecided." When the old path has a live (asked) decision, we inherit it onto
 * the new path — a new event `decided_by: "moved:<original decider>"` — and TOMBSTONE the old path so it
 * doesn't linger as a zombie decided record. No re-ask; same content, same decision. Returns whether it
 * carried anything. (A fingerprint-driven match is the scanner's job to detect the (oldRel,newRel) pairing;
 * this applies the ledger side of it.)
 */
export async function carryOnRename(folder: string, oldRel: string, newRel: string): Promise<boolean> {
  const repoRoot = repoRootFor(folder);
  const prior = foldLedger(readLedger(repoRoot)).get(oldRel);
  if (!prior || !prior.asked) return false; // nothing decided to carry
  const decidedBy = `moved:${prior.decidedBy ?? "unknown"}`;
  await recordDecision(folder, [newRel], { ipfs: prior.ipfs, gitignore: prior.gitignore }, decidedBy, {
    asked: true,
  });
  await recordDecision(folder, [oldRel], {}, decidedBy, { asked: false }); // tombstone the vanished old path
  return true;
}

/**
 * Re-stamp a decision across a COMPRESS/CONVERT (decisions.mdx §12) — needed by the compression flow. The
 * bytes and exact fingerprint change but it is the SAME logical asset, so a file the team already chose to
 * pin must stay pinned after compression rather than fall back to Undecided. We inherit the OLD path's
 * folded axes onto `newRel` (a new attributed event); we do NOT tombstone the old path here (the caller
 * decides whether the original is being replaced in place or kept — a rename that also happens is
 * `carryOnRename`'s job). No-op when the old path has no live decision.
 */
export async function restampOnTransform(
  folder: string,
  oldRel: string,
  newRel: string,
  decidedBy: string | null,
): Promise<boolean> {
  if (oldRel === newRel) return false;
  const repoRoot = repoRootFor(folder);
  const prior = foldLedger(readLedger(repoRoot)).get(oldRel);
  if (!prior || !prior.asked) return false;
  await recordDecision(
    folder,
    [newRel],
    { ipfs: prior.ipfs, gitignore: prior.gitignore },
    decidedBy ?? prior.decidedBy,
    { asked: true },
  );
  return true;
}

/**
 * Identify DECIDED records whose file is no longer live (decisions.mdx §12 delete). Deliberately
 * NON-DESTRUCTIVE: a deleted decided file's record is RETAINED (a transient unmount or an un-fetched
 * teammate must not lose the decision — mirrors the scanner's "retain config for a vanished repo"). Actual
 * dropping is the owning device's COMPACTION job (§5.4), only once the file is gone from the manifest
 * across all peers. This returns the current orphan set so a caller can report/age them; it writes nothing.
 */
export async function staleOrphans(
  folder: string,
  livePaths: string[],
): Promise<{ orphans: string[] }> {
  const repoRoot = repoRootFor(folder);
  const live = new Set(livePaths);
  const orphans: string[] = [];
  for (const rec of foldLedger(readLedger(repoRoot)).values()) {
    if (rec.asked && !live.has(rec.path)) orphans.push(rec.path);
  }
  return { orphans };
}

// ── §13 migration support — seed the shared ledger from the legacy local enum ─

/**
 * Seed the shared ledger from a repo's legacy machine-local `decisions:` enum (decisions.mdx §13), used by
 * the one-time backfill migration. Consent-aware: returns -1 (a sentinel, "not attempted") when this
 * computer does NOT keep `.lfbridge/` (§6) so the caller can retry after consent is later granted; otherwise
 * appends one `decided_by:"migrated"` event per not-yet-migrated `sync`/`ignore` path (stamped with the
 * given `decidedAtIso`, best-known time = the config file's mtime) and returns how many it seeded. Never
 * overwrites newer events — the fold's last-writer-wins protects any hand/teammate decision made later.
 */
export async function seedMigratedLedger(
  folder: string,
  enumMap: Record<string, string>,
  decidedAtIso: string,
): Promise<number> {
  const repoRoot = repoRootFor(folder);
  if (!keepsLfbridge(repoRoot)) return -1; // consent off → don't touch the repo root; caller may retry later
  const existing = readLedger(repoRoot);
  const alreadyMigrated = new Set(existing.filter((e) => e.decided_by === "migrated").map((e) => e.path));
  const sid = decisionSid(folder, repoRoot);
  const events: DecisionEvent[] = [];
  for (const [p, v] of Object.entries(enumMap)) {
    if (v !== "sync" && v !== "ignore") continue; // only real decisions; "undecided"/others are skipped
    if (alreadyMigrated.has(p)) continue; // idempotent — don't double-seed a path
    events.push({
      sid,
      path: p,
      fingerprint: null, // the legacy enum kept no fingerprint (git-ignore axis was never tracked either)
      asked: true,
      ipfs: v === "sync",
      gitignore: false,
      decided_by: "migrated",
      decided_at: decidedAtIso,
    });
  }
  if (events.length === 0) return 0;
  writeLedger(repoRoot, [...existing, ...events]);
  await reconcile(folder);
  return events.length;
}
