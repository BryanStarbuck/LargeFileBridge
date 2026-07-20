// Export Debug Information — the `debug.yaml` state dump (pm/debug.mdx).
//
// Writes ONE per-computer YAML into the personal storage repo:
//     <personal repo>/debug/<computer>/debug.yaml
// containing, for EVERY metric the product renders as a number, the FULL LIST of files behind that
// number (pm/debug.mdx §5). The file is committed and travels over the git backbone, so each of the
// user's computers publishes its own snapshot and a later session can diff two of them and explain why
// a file present on computer 1 never arrived on computer 2 (§1, the A/B/C divergence).
//
// Three rules govern everything here:
//   * COMPLETE, never summarized — a count is worthless for a cross-computer diff (§1.1).
//   * The product's OWN predicates — we bucket the rows `computeRepoDetail` already produced, so the
//     lists can never disagree with the tiles the user is looking at (§5.5).
//   * CHEAP reads only — never `contentPinnedCid`, never a fresh content hash (§10). This reports what
//     the app already believes; re-deriving truth would make it a different, slower, disagreeing tool.
import path from "node:path";
import os from "node:os";
import fs, { promises as fsp } from "node:fs";
import type { DebugExportResult, DebugExportTarget, FileRow, Manifest, ManifestFile } from "@lfb/shared";
import { log } from "../../shared/logging.js";
import { repoFolderKey } from "../../shared/store/sanitize.js";
import { writeYaml } from "../../shared/store/yaml-store.js";
import { computeRepoDetail, folderForRepoId, getRepoConfig, getRepoManifest, listRepoFolders, readGitRemote } from "../store-model/units.service.js";
import { repoUidFor } from "../storage/repo-identity.js";
import { computerLabel, getAppConfig } from "../store-model/config.service.js";
import { getStorageRow } from "../storage/storage.service.js";
import { trackingBaseDir, legacyTrackingBaseDir } from "../storage/storage-type.service.js";
import { auditArtifactCommittability } from "../storage/artifact-committability.service.js";
import { readStorageIndex } from "../storage/tracking.service.js";
import { readSidecar } from "../storage/file-sidecar.service.js";
import { readRepoTrackingManifest } from "../pin/manifest.service.js";
import { missingPinnedFromPeers } from "../pin/pin.service.js";
import { noteArtifactWritten, flushArtifactSync } from "../pin/sync-trigger.service.js";
import { foreignPinByAbsPath } from "../ipfs/foreign-pin.service.js";
import { compressInfo } from "../fs/badges.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { openRepo } from "../git/git.service.js";
import { queueDepth, workerUtilization } from "../jobqueue/jobqueue.service.js";
import { getHardware } from "../storage/hardware.service.js";

// ── the metric catalog (pm/debug.mdx §5.2 — LOCKED) ──────────────────────────────────────────────────
// Every key here is emitted, ALWAYS, even when empty (§5.3): `[]` means "computed, genuinely zero";
// a MISSING key means "this build did not compute it", and collapsing those two makes every conclusion
// drawn from a zero unsound.
const METRIC_KEYS = [
  "add_to_ipfs",
  "git_ignore",
  "big_not_ignored",
  "pull_down",
  "not_backed_up",
  "pending",
  "compressible_videos",
  "compressible_images",
  "already_compressed",
  "transcribable",
  "transcribed",
  "describable",
  "described",
  "ocrable",
  "ocred",
  "pinned_foreign",
  "remote_only",
  "never_ipfs",
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];
type Metrics = Record<MetricKey, DebugFileEntry[]>;

/** One array entry under a metric — level 3 in the YAML, its properties level 4 (§5.1, §7). */
interface DebugFileEntry {
  path: string; // ABSOLUTE, on this computer. NOT comparable across machines (§4.5).
  repo: string; // half the cross-computer join key
  rel: string; // the other half — THIS is what a reader diffs, never `path`
  size_bytes: number;
  cid: string | null;
  sha256: string | null;
  fingerprint: string | null;
  perceptual: { algo: string; value: string } | null;
  decision: string;
  decided_by: string | null;
  decided_at: string | null;
  gitignore: boolean;
  gitignore_rule: { source: string; line: number; pattern: string } | null;
  transfer: string;
  peers: string[];
  pinned_here: boolean | null;
  pinned_foreign: boolean;
  presence: string;
  added_by_device: string | null;
  analysis_only: boolean;
  never_ipfs: boolean;
  tasks: { compress: string; transcribe: string; describe: string; ocr: string };
  changed_at: string | null;
  /** Does the EFFECTIVE decision have a shared-ledger event behind it? `false` with a decided `decision`
   *  is the cross-computer smoking gun (the 2026-07-20 "not backed up: 22 / 0" strand): a frozen-cache-only
   *  decision is honored HERE but has no event that could ever travel, so no other computer can learn it.
   *  Derived from the folded ledger's provenance (decided_at present ⇔ a ledger event exists). */
  decision_in_ledger: boolean;
  /** WHY this entry landed in a compress metric list (present only there): the classifier signal —
   *  "image-extension" / "video-name-mark" / "video-name-no-mark" / "compression-record" — so a
   *  cross-computer diff of compressible lists reads its own explanation instead of needing the code. */
  compress_reason?: string;
  /** PER-OP derived-artifact probe (transcribe / describe / ocr rows only; null elsewhere). For each op
   *  this row could/did run, the artifact path we PROBED, whether it EXISTS, which LAYOUT matched
   *  (tracking-base / beside-media / legacy pre-migration), and whether git CARRIES it (committed =
   *  in the index, pushed = present in origin/<branch>). This is the field that turns "tower described=158,
   *  laptop described=0" into a mechanical read: on the producer every row shows exists+committed+pushed
   *  (or exactly where that chain breaks); on the consumer, exists:false names the artifact that never
   *  arrived (the 2026-07-20 charlie-kirk strand). null booleans = not derivable (no git / no origin). */
  artifacts: Record<string, ArtifactProbe> | null;
}

/** One op's artifact probe (see `artifacts` above). */
interface ArtifactProbe {
  expected_rel: string;
  exists: boolean;
  location: "tracking-base" | "beside" | "legacy" | null;
  committed: boolean | null;
  pushed: boolean | null;
}

export interface ExportDebugOptions {
  /** "computer" = every registered repo (Settings, §6.1); "repo" = exactly one (More ⌄ menu, §6.2). */
  scope: "computer" | "repo";
  /** Required when scope === "repo". */
  repoId?: string;
  /** Provenance of THIS run, recorded in the envelope. */
  invokedFrom: "settings" | "one_repo_more_menu";
  /**
   * Read the per-file YAML sidecars too, adding the PERCEPTUAL fingerprint (§7). OFF by default and
   * deliberately so: measured at ~28 ms per file, it is ~97% of the export's total cost (§10.2). Turn it
   * on only for a narrow, repo-scoped investigation where matching the same content across a re-compress
   * or a format conversion is the actual question.
   */
  deep?: boolean;
}

// ── §3 the precondition: a connected personal storage repo, and NO fallback ───────────────────────────

/**
 * Resolve where the export would land, WITHOUT running it — this is what the Settings section shows the
 * user before they click (§2.1), and what disables both surfaces when there is nowhere legitimate to
 * write (§3). There is deliberately no fallback to the state root or /tmp: a debug.yaml that cannot
 * reach the other computer silently fails at the one job it has.
 */
export function resolveDebugTarget(): DebugExportTarget {
  const computer = repoFolderKey(computerLabel());
  // "Connected" = the personal storage row RESOLVES and its root is on disk — the same idiom the rest of
  // the product uses (artifact-placement.service.ts gates on `page.personal !== null`). Deliberately NOT
  // `initialized`: that flag only means a `storage.yaml` descriptor was written, and real installs are
  // actively using their personal SDL without one (it already holds `devices/` and `files.yaml`).
  // Requiring it would refuse a working setup — verified against this machine, 2026-07-20.
  const personal = getStorageRow("personal");
  if (!personal || !personal.root || !fs.existsSync(personal.root)) {
    return {
      available: false,
      computer,
      path: null,
      reason:
        "Connect your personal storage repo first — Large File Bridge saves the debug file there so your other computers can read it.",
      lastExportAt: null,
    };
  }
  // trackingBaseDir() is the single choke point for the storage-kind rule: a personal SDL is a DEDICATED
  // file repo, so its ROOT is the tracking area and `debug/` hangs directly off it — never `.lfbridge/`
  // (§4.1 rule 1, artifact_placement_policy.mdx §0). Never join LFBRIDGE_DIR by hand here.
  const file = path.join(trackingBaseDir(personal.root, personal.type), "debug", computer, "debug.yaml");
  return { available: true, computer, path: file, reason: null, lastExportAt: lastExportAt(file) };
}

function lastExportAt(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

// ── the run (§9) ─────────────────────────────────────────────────────────────────────────────────────

export async function exportDebugInfo(opts: ExportDebugOptions): Promise<DebugExportResult> {
  const started = Date.now();
  const target = resolveDebugTarget();
  if (!target.available || !target.path) {
    // §3: refuse loudly and specifically. Never a fallback write to a location that cannot travel.
    throw new Error(target.reason ?? "No personal storage repo is connected.");
  }

  const folders = foldersInScope(opts);
  const doc = await buildDebugDocument(opts, folders, target.computer);

  await fsp.mkdir(path.dirname(target.path), { recursive: true });
  writeYaml(target.path, doc as unknown as Record<string, unknown>);

  // §10.1 — the artifact is worthless until it reaches the other computer, so say so EXPLICITLY rather
  // than hoping it rides along on some unrelated commit (the stowaway defect, backbone_resilience.mdx).
  try {
    noteArtifactWritten(target.path, "debug");
    // …and flush the debounce NOW rather than waiting it out. This is the same exemption the batch
    // completion hook takes (sync-trigger.service.ts `flushArtifactSync`): a one-shot, user-initiated
    // export is "a natural checkpoint and the user is watching for it" — the toast has just named the
    // path, so the file must be on its way to the other computer, not sitting on a timer.
    flushArtifactSync();
  } catch (e) {
    log.warn("debug", `debug export written but backbone notify failed: ${(e as Error).message}`);
  }

  const files = METRIC_KEYS.reduce((n, k) => n + doc.metrics[k].length, 0);
  log.info(
    "debug",
    `debug export (${opts.scope}) wrote ${files} entries across ${folders.length} units in ${Date.now() - started}ms → ${target.path}`,
  );
  return {
    path: target.path,
    computer: target.computer,
    scope: opts.scope,
    units: folders.length,
    files,
    counts: METRIC_KEYS.reduce<Record<string, number>>((m, k) => ((m[k] = doc.metrics[k].length), m), {}),
    errors: doc.errors.map((e) => `${e.repo}: ${e.message}`),
    durationMs: Date.now() - started,
  };
}

function foldersInScope(opts: ExportDebugOptions): string[] {
  if (opts.scope === "repo") {
    if (!opts.repoId) throw new Error("repoId is required for a repo-scoped debug export");
    // Direct lookup. An earlier version scanned every folder calling computeRepoDetail until the ids
    // matched — which made a ONE-repo export pay the whole-computer cost (measured 5.1 s for 303 files).
    const folder = folderForRepoId(opts.repoId);
    if (!folder) throw new Error(`unknown repo ${opts.repoId}`);
    return [folder];
  }
  return listRepoFolders();
}

function computeRepoIdSafe(folder: string): string | null {
  try {
    return computeRepoDetail(folder, "unreachable").repoId;
  } catch {
    return null;
  }
}

interface DebugDocument {
  schema_version: number;
  generated_at: string;
  generated_by: string;
  app_version: string;
  computer: Record<string, unknown>;
  scope: Record<string, unknown>;
  environment: Record<string, unknown>;
  errors: Array<{ repo: string; message: string }>;
  counts: Record<string, number>;
  units: Array<Record<string, unknown>>;
  metrics: Metrics;
}

async function buildDebugDocument(
  opts: ExportDebugOptions,
  folders: string[],
  computer: string,
): Promise<DebugDocument> {
  const metrics = emptyMetrics();
  const units: Array<Record<string, unknown>> = [];
  const errors: Array<{ repo: string; message: string }> = [];

  // ONE health read and ONE pinset read for the WHOLE export, shared across every unit (§10).
  const health = await ipfs.health();
  let pinset: Set<string> | undefined;
  try {
    pinset = health === "ok" ? await ipfs.canonicalPinnedSet() : undefined;
  } catch {
    pinset = undefined;
  }

  for (const folder of folders) {
    try {
      const before = METRIC_KEYS.reduce<Record<string, number>>((m, k) => ((m[k] = metrics[k].length), m), {});
      const unit = await exportOneUnit(folder, health, pinset, metrics, !!opts.deep);
      unit.counts = METRIC_KEYS.reduce<Record<string, number>>(
        (m, k) => ((m[k] = metrics[k].length - (before[k] ?? 0)), m),
        {},
      );
      units.push(unit);
    } catch (e) {
      // §9.4 — a partial export that SAYS which part is missing beats no export; but it must say so, or a
      // reader mistakes truncation for evidence of absence.
      errors.push({ repo: folder, message: (e as Error).message });
      log.warn("debug", `debug export skipped ${folder}: ${(e as Error).message}`);
    }
    // Yield between units so a whole-computer export never blocks the event loop (§9.2, performance P-27).
    await new Promise((r) => setImmediate(r));
  }

  const first = folders[0];
  const repoScoped = opts.scope === "repo" && first;
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    generated_by: "debug-export.service.ts",
    app_version: appVersion(),
    computer: await computerBlock(computer),
    scope: {
      kind: opts.scope,
      repo_id: repoScoped ? (computeRepoIdSafe(first) ?? null) : null,
      // The MACHINE-INDEPENDENT identity — join two computers' exports on THIS, never on repo_id (which is
      // a per-device path hash and differs for the same repo on each machine).
      repo_uid: repoScoped ? (units[0]?.repo_uid ?? null) : null,
      repo_name: repoScoped ? (units[0]?.repo ?? null) : null,
      repo_root: repoScoped ? (units[0]?.root ?? null) : null,
      units: folders.length,
      invoked_from: opts.invokedFrom,
      // false ⇒ `perceptual` is null on EVERY entry because it was not read, NOT because no fingerprint
      // exists. A reader must not conclude "no perceptual hash" from a shallow dump (§5.3's reasoning).
      deep: !!opts.deep,
    },
    environment: await environmentBlock(health),
    errors,
    counts: METRIC_KEYS.reduce<Record<string, number>>((m, k) => ((m[k] = metrics[k].length), m), {}),
    units,
    metrics,
  };
}

function emptyMetrics(): Metrics {
  // §5.3 — every key present, ALWAYS. `[]` is a finding; a missing key is a different finding.
  return METRIC_KEYS.reduce((m, k) => ((m[k] = []), m), {} as Metrics);
}

function appVersion(): string {
  return process.env.npm_package_version || "unknown";
}

async function computerBlock(computer: string): Promise<Record<string, unknown>> {
  const hw = safe(() => getHardware(), null);
  return {
    name: computer,
    label: computerLabel(),
    hostname: hw?.hostname ?? os.hostname(),
    platform: process.platform,
    username: os.userInfo().username,
    // THE path-rewrite key (§4.5): absolute paths are not comparable across computers, and this is what
    // lets a reader mechanically translate one machine's paths into the other's.
    home_dir: os.homedir(),
    // Joins this file to the OTHER computer's peer lists by string equality.
    ipfs_peer_id: await safeAsync(() => ipfs.peerId(), null),
    app_uptime_s: Math.round(process.uptime()),
  };
}

/**
 * §4.3 — pre-empts the four questions asked FIRST in every real sync investigation: was IPFS even up, is
 * the backbone pushing, when was the last scan, was work still in flight? A dump produced while IPFS was
 * down describes a momentarily BLIND computer, and a reader who does not know that misdiagnoses every row.
 */
async function environmentBlock(health: string): Promise<Record<string, unknown>> {
  const cfg = safe(() => getAppConfig(), null);
  const util = safe(() => workerUtilization(), { busy: 0, budget: 0 });
  return {
    ipfs: {
      reachable: health === "ok",
      version: await safeAsync(() => ipfs.version(), null),
      pin_count: null,
    },
    git_backbone: await backboneState(),
    scan: {
      roots: cfg?.scanner.roots ?? [],
      big_file_threshold_bytes: cfg?.big_file.threshold_bytes ?? null,
      checked_in_threshold_bytes: cfg?.big_file.checked_in_threshold_bytes ?? null,
    },
    queue: { pending: safe(() => queueDepth(), 0), running: util.busy, budget: util.budget },
  };
}

/** Cheap git state of the personal repo itself — 2-3 spawns for the whole export, not per file. */
async function backboneState(): Promise<Record<string, unknown>> {
  const personal = getStorageRow("personal");
  if (!personal) return { enabled: false, root: null, branch: null, ahead: null, behind: null, last_commit_at: null };
  try {
    const git = openRepo(personal.root);
    const status = await git.status();
    const last = await git.log({ maxCount: 1 });
    return {
      enabled: true,
      root: personal.root,
      branch: status.current ?? null,
      ahead: status.ahead,
      behind: status.behind,
      dirty: status.files.length,
      last_commit_at: last.latest?.date ?? null,
    };
  } catch (e) {
    return { enabled: true, root: personal.root, error: (e as Error).message };
  }
}

// ── one unit (§9 steps 5-7) ──────────────────────────────────────────────────────────────────────────

async function exportOneUnit(
  folder: string,
  health: Awaited<ReturnType<typeof ipfs.health>>,
  pinset: Set<string> | undefined,
  metrics: Metrics,
  deep: boolean,
): Promise<Record<string, unknown>> {
  // §5.5 — call the product's OWN composition path and bucket THOSE rows. Never re-derive: an export that
  // computes a metric even slightly differently from the tile lies, and lies plausibly.
  const detail = computeRepoDetail(folder, health, pinset);
  const root = repoRootFor(folder);
  const missing = await safeAsync(() => missingPinnedFromPeers(root), []);

  // ONE git-tracked read + ONE origin-tree read per unit (not per file) so every analysis row can carry
  // its per-op artifact probe (committed / pushed) — see `DebugFileEntry.artifacts`.
  const gitCtx = await safeAsync(() => artifactGitContext(root), null);
  const enrich = makeEnricher(folder, root, detail.name, deep, gitCtx);
  bucketMetrics(detail.files, metrics, enrich);

  // pull_down is the ONE metric whose files are not on this disk at all — it comes from a peer's manifest.
  for (const m of missing) {
    metrics.pull_down.push({
      ...blankEntry(path.join(root, m.path), detail.name, m.path),
      size_bytes: m.sizeBytes,
      cid: m.cid,
      presence: "remote-only",
      added_by_device: m.addedByDevice,
      decision: "sync",
    });
  }

  const remote = detail.remote ?? safe(() => readGitRemote(root), null);
  return {
    repo: detail.name,
    repo_id: detail.repoId,
    // `repo_id` is sha1(absolute path) — DELIBERATELY device-local, so the same repo carries a DIFFERENT
    // repo_id on each computer and must never be used as a cross-machine join key. `repo_uid` is the
    // machine-independent identity (sha1 of the normalized remote, repo-identity.ts `repoUidFor`) — the
    // key the sync-repo mirror `repos/<uid>/` uses, and the one a two-computer diff should join on.
    repo_uid: safe(() => repoUidFor(remote), null),
    root,
    // Folder NAMES can differ between computers; the git remote cannot. This is what proves two `units:`
    // rows are the same repo (§8).
    remote,
    owner: detail.owner ?? null,
    pinned: detail.pinned,
    status: detail.status,
    last_scan_at: detail.lastScanAt,
    last_pin_at: detail.lastPinAt,
    peer_count: detail.peerCount,
    file_rows: detail.files.length,
    task_metrics: detail.taskMetrics ?? null,
    decision_counts: detail.counts,
    // WHY two computers legitimately report different compressible counts for the SAME repo (the 45-vs-70
    // charlie-kirk strand, 2026-07-20): compressible only counts rows with LOCAL bytes, and git-ignored
    // media exists unevenly across machines. This block quantifies the two visibility gaps so the reader
    // subtracts them instead of suspecting the classifier (which is name+record based and device-agnostic).
    compress_visibility: compressVisibility(detail.files),
    // Did the transcripts/AI descriptions/OCR text this repo produced actually make it INTO git — on disk
    // vs tracked vs blocked-by-.gitignore vs committed-but-unpushed? This is the block that turns "tower
    // says transcribed=59, laptop says transcribed=1" from an afternoon of forensics into one read:
    // `59 on disk, 0 tracked, blocked by .gitignore:29:.lfbridge/` (the 2026-07-20 charlie-kirk strand).
    // null = the repo has no .lfbridge/ yet (nothing to audit). Cheap: one walk + 3 git spawns per unit.
    artifact_health: await safeAsync(() => auditArtifactCommittability(root), null),
    counts: {},
  };
}

/**
 * The two structural reasons compress metrics diverge between the user's computers, counted per repo:
 *   • `remote_only_media_unassessed` — media rows another computer pinned but this one holds no bytes for;
 *     compress is "na" by design (storage_company.mdx §8.5), so the OTHER computer counts them and this one
 *     never will until they are pulled down.
 *   • `local_media_invisible_to_peers` — local media rows with NO manifest CID (undecided / never pinned);
 *     nothing about them travels, so every OTHER computer has no row at all — not even remote-only.
 * Cheap: one pass over rows already composed. Media = compressInfo kind ≠ null (video/image).
 */
function compressVisibility(files: FileRow[]): Record<string, number> {
  let remoteOnlyMedia = 0;
  let invisibleLocalMedia = 0;
  for (const f of files) {
    if (f.analysisOnly) continue;
    if (compressInfo(path.basename(f.path)).compressible === null) continue;
    if (f.presence === "remote-only") remoteOnlyMedia++;
    else if (f.cid == null) invisibleLocalMedia++;
  }
  return {
    remote_only_media_unassessed: remoteOnlyMedia,
    local_media_invisible_to_peers: invisibleLocalMedia,
  };
}

function repoRootFor(folder: string): string {
  const p = getRepoConfig(folder).repo.path;
  if (!p) throw new Error(`repo ${folder} has no path`);
  return path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/**
 * §5.5 — the product's predicates, VERBATIM, including the two order-dependent early exits. Getting
 * either `continue` wrong produces lists that disagree with the tiles, which is the one defect this
 * artifact cannot survive.
 */
function bucketMetrics(files: FileRow[], metrics: Metrics, enrich: (f: FileRow) => DebugFileEntry): void {
  const checkedIn = safe(() => getAppConfig().big_file.checked_in_threshold_bytes, 52428800) ?? 52428800;
  for (const f of files) {
    const e = enrich(f);

    // The three analysis metrics count EVERY row, including sub-threshold analysis-only media.
    if (f.transcribe === "could") metrics.transcribable.push(e);
    if (f.transcribe === "done") metrics.transcribed.push(e);
    if (f.describe === "could") metrics.describable.push(e);
    if (f.describe === "done") metrics.described.push(e);
    if (f.ocr === "could") metrics.ocrable.push(e);
    if (f.ocr === "done") metrics.ocred.push(e);

    if (f.neverIpfs) metrics.never_ipfs.push(e);

    // Early exit 1 — analysis-only rows are never payload and never count toward decision/space metrics.
    if (f.analysisOnly) continue;

    // Early exit 2 — a remote-only row contributes `undecided` and nothing else.
    if (f.presence === "remote-only") {
      metrics.remote_only.push(e);
      if (f.decision === "undecided") metrics.add_to_ipfs.push(e);
      continue;
    }

    if (f.decision === "undecided" && !f.pinnedForeign) metrics.add_to_ipfs.push(e);
    if (f.pinnedForeign) metrics.pinned_foreign.push(e);
    if (f.decision === "sync" && f.transfer === "pending") metrics.pending.push(e);
    if (f.decision === "sync" && f.cid != null && !hasOtherPeer(f)) metrics.not_backed_up.push(e);
    if (f.compress === "could") {
      // Split by the SAME classifier the tile uses (units.service.ts computeTaskMetrics →
      // badges.ts compressInfo) — a local extension set here would drift the moment compressInfo
      // learns a new type, breaking the §5.5 lists-match-tiles guarantee.
      const img = compressInfo(path.basename(f.path)).compressible === "image";
      (img ? metrics.compressible_images : metrics.compressible_videos).push({
        ...e,
        compress_reason: img ? "image-extension" : "video-name-no-mark",
      });
    }
    if (f.compress === "done") {
      // Name the SIGNAL that classified it done: a name-level verdict (extension / compressed-mark), or —
      // when the name still says "should" — the travelling compression record (compress.mdx §8.2).
      const ci = compressInfo(path.basename(f.path));
      metrics.already_compressed.push({
        ...e,
        compress_reason:
          ci.compressState === "done"
            ? ci.compressible === "image"
              ? "image-extension"
              : "video-name-mark"
            : "compression-record",
      });
    }
    if (!f.gitignore && f.sizeBytes >= checkedIn) metrics.big_not_ignored.push(e);
    // The Git Ignore TILE's predicate (client-side, no size test) — kept distinct from big_not_ignored so
    // each list matches the number the user actually sees (task_tabs.mdx §2.5).
    if (!f.gitignore && !f.gitignoreLocked && !f.analysisOnly) metrics.git_ignore.push(e);
  }
}

function hasOtherPeer(f: FileRow): boolean {
  const self = computerLabel();
  return f.peers.some((p) => p !== self);
}

// (image/video split now delegates to badges.ts compressInfo — see bucketMetrics.)

// ── enrichment (§7) ──────────────────────────────────────────────────────────────────────────────────

/**
 * Builds one level-4 property bag per file. Every join here is a CHEAP read of state the app already
 * holds — the manifest for sha256/peers, files.yaml for the fingerprint, the sidecar for the perceptual
 * hash, the foreign-pin index for out-of-band pins. Never a fresh content hash, never contentPinnedCid
 * (§10): an export nobody is willing to run is worth nothing.
 */
function makeEnricher(
  folder: string,
  root: string,
  repoName: string,
  deep: boolean,
  gitCtx: ArtifactGitContext | null = null,
): (f: FileRow) => DebugFileEntry {
  const manifest = manifestIndex(folder, root);
  const index = new Map(safe(() => readStorageIndex(root), [])?.map((r) => [r.path, r]) ?? []);
  const probeArtifacts = makeArtifactProber(root, gitCtx);
  return (f: FileRow): DebugFileEntry => {
    const abs = path.join(root, f.path);
    const mf = manifest.get(f.path);
    const idx = index.get(f.path);
    // MEASURED 2026-07-20: readSidecar costs ~28 ms per file — 109 s of a 112 s run over 25 repos / 3,850
    // rows, i.e. 97.5% of the whole export, while every other read together came to 2.8 s. It is therefore
    // OFF by default and reachable only via `deep` (§10.2). The cheap `files.yaml` fingerprint below covers
    // the "has this file changed?" question; only the PERCEPTUAL hash is lost, and paying two orders of
    // magnitude for it by default would make the export something nobody is willing to run.
    const sc = deep ? safe(() => readSidecar(root, f.path), null) : null;
    const fp = sc?.file?.fingerprint ?? null;
    return {
      path: abs,
      repo: repoName,
      rel: f.path,
      size_bytes: f.sizeBytes,
      cid: f.cid,
      sha256: mf?.sha256 ?? null,
      fingerprint: idx?.fingerprint ?? sc?.file?.hash ?? null,
      perceptual: fp ? { algo: fp.algo, value: fp.value } : null,
      decision: f.decision,
      decided_by: f.decidedBy ?? null,
      decided_at: f.decidedAt ?? null,
      gitignore: f.gitignore ?? false,
      gitignore_rule: f.gitignoreRule ?? null,
      transfer: f.transfer,
      // `peers` on one computer vs presence on the other is the single most diagnostic comparison in the
      // whole file (§7) — it is what separates "the manifest never travelled" (git) from "the fetch
      // failed" (IPFS).
      peers: mf?.pinned_by?.length ? mf.pinned_by : f.peers,
      // null means NOT VERIFIED (IPFS was down) and must never be read as false (§7).
      pinned_here: f.pinnedHere ?? null,
      pinned_foreign: f.pinnedForeign ?? !!safe(() => foreignPinByAbsPath(abs), undefined),
      presence: f.presence ?? "local",
      added_by_device: f.addedByDevice ?? null,
      analysis_only: f.analysisOnly ?? false,
      never_ipfs: f.neverIpfs ?? false,
      tasks: {
        compress: f.compress ?? "na",
        transcribe: f.transcribe ?? "na",
        describe: f.describe ?? "na",
        ocr: f.ocr ?? "na",
      },
      changed_at: f.changedAt ?? null,
      decision_in_ledger: f.decidedAt != null,
      artifacts: probeArtifacts(f),
    };
  };
}

// ── per-op artifact probe (`DebugFileEntry.artifacts`) ───────────────────────────────────────────────

/** Git facts shared by every row of one unit: the set of repo-relative paths in the INDEX (committed) and
 *  in origin/<branch> (pushed), both scoped to the artifact tree. null members = not derivable. */
interface ArtifactGitContext {
  tracked: Set<string> | null;
  pushed: Set<string> | null;
}

/** Two spawns per unit: `git ls-files` (committed) and `git ls-tree -r origin/<branch>` (pushed), both
 *  pathspec-scoped to the quarantine dir. Never throws upward — callers wrap in safeAsync. */
async function artifactGitContext(root: string): Promise<ArtifactGitContext | null> {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const git = openRepo(root);
  const split = (raw: string): Set<string> => new Set(raw.split("\0").filter(Boolean));
  let tracked: Set<string> | null = null;
  let pushed: Set<string> | null = null;
  try {
    tracked = split(await git.raw(["ls-files", "-z"]));
  } catch {
    tracked = null;
  }
  try {
    const branch = (await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    pushed = split(await git.raw(["ls-tree", "-r", "-z", "--name-only", `origin/${branch}`]));
  } catch {
    pushed = null; // no origin / unborn branch — "pushed" is simply not derivable
  }
  return { tracked, pushed };
}

const ARTIFACT_OP_EXTS: Record<string, string> = {
  transcribe: ".transcription",
  describe: ".ai_description",
  ocr: ".ocr",
};

/**
 * Build the per-row artifact prober: for each analysis op this row could/did run, probe the artifact in
 * every layout the reader accepts — the tracking base (default), beside the media, and the legacy
 * pre-migration base — mirroring tracking.service `analysisOutputs()` exactly, and fold in the unit's git
 * facts. A few statSyncs per analysis row; non-media rows pay nothing (null).
 */
function makeArtifactProber(root: string, gitCtx: ArtifactGitContext | null): (f: FileRow) => Record<string, ArtifactProbe> | null {
  // Storage-KIND-aware bases (artifact_placement_policy.mdx §0) — resolveStorageType is memoized, so the
  // two resolvers below cost one descriptor read for the whole unit.
  const base = safe(() => trackingBaseDir(root), root);
  const legacy = safe(() => legacyTrackingBaseDir(root), null);
  const isFileAt = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  return (f: FileRow): Record<string, ArtifactProbe> | null => {
    const ops = (["transcribe", "describe", "ocr"] as const).filter((op) => (f[op] ?? "na") !== "na");
    if (ops.length === 0) return null;
    const out: Record<string, ArtifactProbe> = {};
    for (const op of ops) {
      const ext = ARTIFACT_OP_EXTS[op]!;
      const candidates: Array<[ArtifactProbe["location"], string]> = [
        ["tracking-base", path.join(base, f.path) + ext],
        ["beside", path.join(root, f.path) + ext],
        ...(legacy ? ([["legacy", path.join(legacy, f.path) + ext]] as Array<[ArtifactProbe["location"], string]>) : []),
      ];
      const hit = candidates.find(([, p]) => isFileAt(p));
      const expectedAbs = hit ? hit[1] : candidates[0]![1];
      const rel = path.relative(root, expectedAbs).split(path.sep).join("/");
      out[op] = {
        expected_rel: rel,
        exists: !!hit,
        location: hit ? hit[0] : null,
        committed: gitCtx?.tracked ? gitCtx.tracked.has(rel) : null,
        pushed: gitCtx?.pushed ? gitCtx.pushed.has(rel) : null,
      };
    }
    return out;
  };
}

/** The unit manifest folded with the repo's tracking manifest — where sha256 and pinned_by live. */
function manifestIndex(folder: string, root: string): Map<string, ManifestFile> {
  const out = new Map<string, ManifestFile>();
  const add = (m: Manifest | null) => {
    for (const f of m?.files ?? []) {
      const prev = out.get(f.path);
      if (!prev) out.set(f.path, f);
      else {
        out.set(f.path, {
          ...prev,
          cid: prev.cid ?? f.cid,
          sha256: prev.sha256 ?? f.sha256,
          pinned_by: Array.from(new Set([...(prev.pinned_by ?? []), ...(f.pinned_by ?? [])])),
        });
      }
    }
  };
  add(safe(() => getRepoManifest(folder), null));
  add(safe(() => readRepoTrackingManifest(root), null));
  return out;
}

function blankEntry(abs: string, repo: string, rel: string): DebugFileEntry {
  return {
    path: abs,
    repo,
    rel,
    size_bytes: 0,
    cid: null,
    sha256: null,
    fingerprint: null,
    perceptual: null,
    decision: "undecided",
    decided_by: null,
    decided_at: null,
    gitignore: false,
    gitignore_rule: null,
    transfer: "na",
    peers: [],
    pinned_here: null,
    pinned_foreign: false,
    presence: "local",
    added_by_device: null,
    analysis_only: false,
    never_ipfs: false,
    tasks: { compress: "na", transcribe: "na", describe: "na", ocr: "na" },
    changed_at: null,
    decision_in_ledger: false,
    artifacts: null,
  };
}

// ── tiny guards — a debug export must never be the thing that throws ─────────────────────────────────

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
