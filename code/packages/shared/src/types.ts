// @lfb/shared — the cross-package contract (backend REST ↔ frontend).
// These mirror the LOCKED vocabulary in pm/repos.mdx and pm/one_repo.mdx.

// ── Decision model (one_repo.mdx §1, LOCKED) ────────────────────────────────
// FROZEN wire value: the "sync" literal is stored in on-disk `decisions:` maps and travels between
// computers (it drives git-ignore + SyncList membership), so it is deliberately NOT renamed. In the
// UI it is always presented as "Add to IPFS (pin)". Do not rename this value.
export type Decision = "sync" | "ignore" | "undecided";

export type TransferStatus =
  | "pinned"
  | "pending"
  | "fetching"
  | "pushing"
  | "missing"
  | "error"
  | "na";

// ── Repo rollup status (repos.mdx §1/§4.2, LOCKED) ──────────────────────────
export type RepoStatus =
  | "up_to_date"
  | "pinning"
  | "behind"
  | "needs_review"
  | "error"
  | "never";

export interface RepoCounts {
  pinned: number;
  pending: number;
  undecided: number;
  ignored: number;
}

// A repo's company/personal ownership (repo_company_mapping.mdx §1.1). `kind` is the split; `companyId` is
// the owning company storage's id (null until that storage exists — auto-create is a later seam);
// `displayName` is what the product shows ("Personal", or the friendly/derived company name); `source` is
// auto-derived-from-git-remote vs. a user override; `host`/`ownerSlug` record the remote origin used.
export interface RepoOwner {
  kind: "personal" | "company";
  companyId: string | null;
  displayName: string;
  source: "auto" | "manual";
  host: string | null;
  ownerSlug: string | null;
}

// One pending repo→company ownership mapping awaiting this member's consent (repo_owner_propagation.mdx §3).
// A company member asserted (on their computer) that a repo belongs to the company; the assertion travelled in
// `<syncRepo>/owner_map.yaml`. On THIS computer it becomes a pending row — a repo whose git remote matches the
// assertion but which is not yet owned by that company locally and was not previously declined. It turns into
// this member's local `owner_override` only after they consent through the review page (§4).
export interface PendingCompanyMapping {
  repoId: string; // the local repo this resolves to (matched by remote)
  repoName: string; // display name for the row
  remoteKey: string; // "github.com/ACT3ai/jfksocial_server" — the matched normalized-remote key
  companyId: string; // the asserting company (its company storage id)
  companyName: string; // its friendly display name (storage_company.mdx §6)
  assertedBy: string; // who asserted it — shown so the member knows the source
  assertedAt: string; // when (ISO)
}

// One row's decision in the review page's batch apply (repo_owner_propagation.mdx §4.1). "company" = accepted
// (write a local owner_override to the company); "personal" = declined (stay Personal, remember the decline).
export interface CompanyMappingSelection {
  repoId: string;
  decision: "company" | "personal";
}

// What POST /api/company-mappings/apply returned — the batch outcome (repo_owner_propagation.mdx §4.3).
export interface CompanyMappingApplyResult {
  accepted: number; // rows written to a company owner_override
  declined: number; // rows recorded as a remembered decline
  skipped: number; // selections that no longer matched a pending mapping (repo gone / already resolved)
}

// One row of the Repos table (repos.mdx §1).
export interface RepoRow {
  repoId: string; // stable hash of the absolute path
  bookmarked: boolean; // user favorite (repos.mdx §8) — drives the leading ribbon toggle
  name: string;
  path: string;
  counts: RepoCounts;
  peerCount: number;
  lastPinAt: string | null;
  status: RepoStatus;
  pinned: boolean; // per-repo master toggle (one_repo.mdx §3.2)
  owner?: RepoOwner; // company/personal mapping (repo_company_mapping.mdx §7) — drives left-bar grouping
}

// Per-file status for a task tab (task_tabs.mdx §4.4/§5/§6). "could" = an actionable candidate
// (a compressible-but-uncompressed media file / a transcribable file with no transcript yet); "done" =
// the task is already handled; "na" = the task does not apply to this file kind. Drives the three-state
// Transcribe/Compress status icons and the per-tab row filters + default sort.
export type TaskStatus = "could" | "done" | "na";

// One row of the files table on the One-repo screen (one_repo.mdx §1).
export interface FileRow {
  fileId: string; // repoId + relative path (stable)
  path: string; // relative to repo root
  sizeBytes: number;
  cid: string | null;
  decision: Decision;
  transfer: TransferStatus;
  peers: string[];
  changedAt: string;
  // Compress task status (task_tabs.mdx §6) — from the extension verdict compressInfo(name): "could" =
  // a video/image that looks uncompressed, "done" = already compressed, "na" = not a compressible kind.
  compress?: TaskStatus;
  // Transcribe task status (task_tabs.mdx §5) — "could" = audio/video with no .transcription sidecar yet,
  // "done" = a transcript exists, "na" = not audio/video.
  transcribe?: TaskStatus;
  // AI-description task status (ai_description.mdx §11) — mirrors transcribe: "could" = image/video with no
  // .ai_description sidecar yet, "done" = a description exists, "na" = not image/video (audio → transcription).
  describe?: TaskStatus;
  // Decision provenance from the folded, team-shared ledger (decisions.mdx §10). Both null when the file
  // has no decision record yet (Undecided). `decidedBy` is the allow-listed email, the sentinel
  // "policy:<email>" for a policy auto-decision, or null when attribution is anonymous.
  decidedBy?: string | null;
  decidedAt?: string | null; // ISO-8601 UTC of the winning decision event
  // Sticky "Never IPFS" flag (menus.mdx §6.6, decisions.mdx §17). When true the Add-to-IPFS decision axis
  // is forbidden — the UI disables/forces-off the IPFS checkbox and the write path rejects ipfs:true.
  neverIpfs?: boolean;
  // Current git-ignore axis (decisions.mdx §1), read from GIT ITSELF (`git check-ignore`) — NOT folded
  // from the decision ledger. True = git really ignores this file, whatever rule causes it (our own
  // toggle, a hand-written line, or a pattern like `**/videos/**`). Drives the inline Add-to-git-ignore
  // (⊘) toggle (decision_toggles.mdx). Independent of `decision` (which is the IPFS-axis projection).
  gitignore?: boolean;
  // True when `gitignore` is on via a rule LFBridge must NOT rewrite (a broad/pattern rule, or one from
  // outside the repo's root .gitignore). The ⊘ toggle then renders ON but NON-INTERACTIVE and names the
  // rule — turning it off is the user's edit to make (git_ignore.mdx §5.5). Absent/false = our exact
  // anchored line owns it, so clicking OFF really un-ignores the file.
  gitignoreLocked?: boolean;
  // The rule that ignores this file, for the "Ignored by .gitignore:3 — `**/videos/**`" explanation.
  // `source` is a basename (e.g. ".gitignore"). Absent when the file is not ignored.
  gitignoreRule?: { source: string; line: number; pattern: string };
}

// One file a peer computer pinned that THIS computer is missing — the subject of the "pull them down"
// warning (warnings.mdx §10.8.12). Described from the committed manifest + the peer's sidecar identity,
// because the bytes are not here yet.
export interface MissingPinnedFile {
  path: string; // repo-relative path (the row's stable id; what POST /pull receives)
  name: string;
  sizeBytes: number; // from the manifest/sidecar (bytes are absent locally)
  cid: string; // the manifest CID to pin (fetches the bytes on pin)
  addedByDevice: string | null; // the peer device that pinned it ("added by {device}")
}

// Per-tab "what could be done" metric counts (task_tabs.mdx §2.5). Rolled up from the file rows; the
// MetricsStrip renders one panel per count for the active tab (a light-green big-0 when a count is 0).
// `pullDown` is NOT here — it comes from RepoDetail.missingPinned.length (computed in the router).
export interface TaskMetrics {
  undecided: number; // files with no decision yet
  pending: number; // sync files queued to transfer
  notBackedUp: number; // sync files with a CID but 0 peers (live only on this machine)
  compressibleVideos: number; // videos that look uncompressed
  compressibleImages: number; // images that look uncompressed / convertible
  alreadyCompressed: number; // media already compressed
  transcribable: number; // audio/video with no transcript yet ("could")
  transcribed: number; // audio/video that already have a transcript ("done")
  describable: number; // image/video with no AI description yet ("could") — mirrors transcribable
  described: number; // image/video that already have an AI description ("done")
  bigNotIgnored: number; // large files not yet git-ignored (the git-ignore nudge)
}

// The One-repo detail payload: header/status strip + file rows.
export interface RepoDetail {
  repoId: string;
  name: string;
  path: string;
  remote: string | null;
  pinned: boolean;
  status: RepoStatus;
  peerCount: number;
  lastPinAt: string | null;
  // When this repo was last scanned for big files (ISO), or null if never. Drives the "Scan now"
  // header primary when the repo is scan-stale (one_repo.mdx §3.1 / scan.mdx §2.3).
  lastScanAt: string | null;
  ipfs: IpfsHealth;
  counts: RepoCounts;
  files: FileRow[];
  // Files a peer computer of yours pinned that this computer lacks — drives the "pull them down" warning
  // (warnings.mdx §10.8.12). Empty/absent when there is nothing to pull.
  missingPinned?: MissingPinnedFile[];
  // Per-tab "what could be done" metric counts for the task-tab MetricsStrip (task_tabs.mdx §2).
  taskMetrics?: TaskMetrics;
  // Company/personal mapping (repo_company_mapping.mdx §7) — drives the Ownership section + grouping.
  owner?: RepoOwner;
}

export type IpfsHealth = "ok" | "unreachable";

// What a single pin run actually DID — so the UI reports the truth, never a fixed "complete" string
// (pin_process.mdx §6). `eligible` is how many files were marked "sync" (the FROZEN wire decision that
// means "add to IPFS") this run: 0 means there was nothing to pin (an honest no-op), not a failure.
export interface PinCounts {
  eligible: number; // files marked "sync" (add-to-IPFS) this run (0 ⇒ nothing to pin)
  added: number; // files newly added to IPFS this run
  pinned: number; // files this run ensured a local pin for (added + fetched-and-pinned)
  fetched: number; // missing files materialized from a peer this run
  skipped: number; // eligible files already up-to-date (unchanged + still pinned)
  failed: number; // files whose add/pin/fetch errored
}

// ── TO DO Batches (to_do_batches.mdx / to_do.mdx) ────────────────────────────────
// A per-storage bundle of recommended file actions the TO DO Batch Calc Engine produced during a scan
// recalc. These are the API DTOs the To Do page reads; the on-disk YAML shape is TodoBatchDocSchema
// (schemas.ts). One batch per storage; only batches WITH work render as slugs.

// The recommendable action categories (to_do_batches.mdx §3). `transcribe_*` belong to transcribe batches.
export type TodoCategory =
  | "compress_video"
  | "compress_image"
  | "git_ignore"
  | "pin"
  | "pull_down"
  | "transcribe_video"
  | "transcribe_audio";

// Which storage a batch is scoped to (to_do_batches.mdx §1).
export type TodoBatchScope = "personal" | "dropbox" | "gdrive" | "repo" | "company" | "community";

// The slug-template hint (to_do_batches.mdx §3.2 / to_do.mdx §5.1). Unknown → "mixed".
export type TodoBatchPattern =
  | "compress"
  | "git_ignore"
  | "pull_down"
  | "pin"
  | "transcribe"
  | "mixed";

// One category's rollup, read by the slug WITHOUT opening every item (to_do_batches.mdx §3.1).
export interface TodoCategoryTotal {
  count: number;
  reclaimableBytes?: number; // compress categories: bytes reclaimable if compressed
}

// The recommended target per axis for one file (the RECOMMENDED decision-toggle state, decision_toggles.mdx).
export interface TodoRecommend {
  ipfs?: boolean;
  gitignore?: boolean;
  compress?: boolean;
}

// One recommendation the batch popup renders as a row (to_do_batches.mdx §3).
export interface TodoBatchItem {
  path: string; // relative to storageRoot
  sizeBytes: number;
  category: TodoCategory;
  cid?: string | null;
  pinnedOn?: string[]; // devices that already hold it (pull_down)
  estCompressedBytes?: number; // compress categories
  recommend: TodoRecommend;
}

// The slug-shaped summary the To Do page list renders (GET /api/todo/batches).
export interface TodoBatchSummary {
  id: string; // "<scope>:<slug>"
  scope: TodoBatchScope;
  storageName: string;
  storageRoot: string;
  kind: "todo" | "transcribe";
  pattern: TodoBatchPattern;
  repoId?: string; // present for repo batches → the slug/popup can route to /repos/$repoId
  totals: Partial<Record<TodoCategory, TodoCategoryTotal>>;
  dismissed: boolean;
  computedAt: string;
}

// The full batch with items (GET /api/todo/batches/:id) — powers the batch popup.
export interface TodoBatchDetail extends TodoBatchSummary {
  items: TodoBatchItem[];
}

// What Apply returned (POST /api/todo/batches/:id/apply) — the async hand-off count.
export interface TodoApplyResult {
  applied: number; // files acted on
  pins: number; // files queued to pin/pull
  gitignored: number;
  compressed: number;
  transcribed: number;
}

// The on-demand transcribe scan result (POST /api/todo/transcribe-scan).
export interface TranscribeScanResult {
  batches: number; // transcribe batches written
  candidates: number; // total transcribable-not-yet-transcribed files found
}

// The POST /repos/:id/pin response: the refreshed repo detail plus what THIS run did (pin_process.mdx §6).
export interface PinNowResult {
  detail: RepoDetail;
  counts: PinCounts;
}

// ── The IPFS page (ipfs.mdx) — the local pinset as ground truth ──────────────
// One row per pinned ROOT CID (indirect blocks rolled under their root — ipfs.mdx §1).
export type IpfsPinType = "recursive" | "direct" | "mfs";

// Tracked state (ipfs.mdx §5.1):
//   pinned    — pinned AND in a manifest with a known local path (the normal state)
//   import    — pinned but NOT in any manifest (the actionable import candidate)
//   path-less — tracked (in a manifest) but with no resolvable local path
export type IpfsTracked = "pinned" | "import" | "path-less";

export interface IpfsPinRow {
  cid: string; // the pinned root CID
  file: string | null; // resolved basename when known, else null (UI shows the CID)
  path: string | null; // absolute local path when resolved (drives cell-nav + kebab)
  sizeBytes: number; // pinned size (manifest for tracked; object/stat best-effort for untracked)
  pinType: IpfsPinType;
  tracked: IpfsTracked;
  unit: string | null; // repo name (or "computer") the pin belongs to; null for untracked
  repoId: string | null; // owning repo (drives the left-bar child filter — ipfs.mdx §2.1); null otherwise
  peers: number; // how many of your computers also pin this CID (0 on a tracked file = not backed up)
  seenAt: string | null; // last time a scan confirmed this pin
}

// The node-status / security card (ipfs.mdx §3) — reflects AND guards only-our-content.
export interface IpfsNodeCard {
  health: IpfsHealth;
  peerId: string | null;
  reprovideStrategy: "pinned" | "roots" | "all";
  gatewayLocalOnly: boolean; // gateway bound to loopback only (compliant)
  publicGateway: boolean; // the deliberate opt-out setting (settings.mdx) — turns a red flag amber
  compliant: boolean; // reprovide ∈ {pinned,roots} AND no public/recursive gateway (knowledge/ipfs.mdx §6)
  gcOn: boolean; // garbage collection enabled (incidental third-party cache stays transient)
  pinnedCount: number;
  pinnedBytes: number;
  trackedCount: number;
  untrackedCount: number; // the import backlog
}

// One left-bar disclosure child (ipfs.mdx §2.1) — a repo that holds ≥1 tracked pin.
export interface IpfsRepoGroup {
  repoId: string;
  name: string;
  pinnedCount: number;
}

// GET /api/ipfs — the whole IPFS page payload.
export interface IpfsPageData {
  node: IpfsNodeCard;
  pins: IpfsPinRow[];
  repos: IpfsRepoGroup[]; // pinning repos → the left-bar children
}

// POST /api/ipfs/import result — import is METADATA-ONLY (ipfs.mdx §4).
export interface IpfsImportResult {
  imported: number; // CIDs newly brought under tracking
  skipped: number; // CIDs that were already tracked / not importable
  data: IpfsPageData; // fresh page payload after the import
}

// POST /api/ipfs/pin — pin/unpin a single CID (`ipfs pin add` / `ipfs pin rm`, ipfs.mdx §3).
// Drives the toggle pin control shown on every file/CID that can be pinned. The returned `pinned`
// is the VERIFIED state read back from the node, so the UI settles on ground truth after the toggle.
export interface IpfsPinToggle {
  cid: string;
  pinned: boolean;
}

// ── The IPFS DASHBOARD / node control panel (ipfs_ui.mdx) ────────────────────
// The landing page at /ipfs: is the node installed & running, an on/off toggle, live metrics,
// gateway summary, and the only-our-content posture. The pinset table (above) is a drill-in.
export type IpfsPlatform = "darwin" | "win32" | "linux" | "other";

// The gateway summary shown on the dashboard (ipfs_ui.mdx §5.1 / §4 row 10).
export interface IpfsGatewaySummary {
  enabled: boolean; // a gateway address is configured/listening
  localOnly: boolean; // bound to loopback only (compliant — knowledge/ipfs.mdx §8)
  url: string | null; // e.g. http://127.0.0.1:8081 (null when unknown/none)
  addr: string | null; // the raw multiaddr, e.g. /ip4/127.0.0.1/tcp/8081
}

// Live node metrics — every field nullable; an unknown value renders as "—" (ipfs_ui.mdx §5.2).
export interface IpfsNodeMetrics {
  sharedFiles: number | null; // recursive+direct pin count (the pinset size)
  untrackedFiles: number | null; // pinned-but-untracked (the /ipfs/pins import backlog)
  repoObjects: number | null; // repo/stat NumObjects (blocks)
  repoSizeBytes: number | null; // repo/stat RepoSize (bytes on disk)
  storageMaxBytes: number | null; // repo/stat StorageMax (the GC cap)
  peersConnected: number | null; // swarm/peers count
  bandwidthTotalIn: number | null; // stats/bw TotalIn (bytes)
  bandwidthTotalOut: number | null; // stats/bw TotalOut (bytes)
  bandwidthRateIn: number | null; // stats/bw RateIn (bytes/s)
  bandwidthRateOut: number | null; // stats/bw RateOut (bytes/s)
}

// Auto-start-on-reboot posture (ipfs_ui.mdx §13). On macOS this is a per-user launchd LaunchAgent
// (com.largefilebridge.ipfs) that runs `ipfs daemon --enable-gc` at login/boot. `supported` is false
// on OSes we don't yet automate (the UI then hides the auto-start option and shows only plain start).
export interface IpfsAutostartStatus {
  supported: boolean; // this OS can auto-start IPFS on reboot (macOS/launchd today)
  installed: boolean; // the LaunchAgent (plist) exists on disk
  enabled: boolean; // it is loaded in launchd — i.e. it WILL run at the next reboot/login
}

// POST /api/ipfs/autostart — install (set up reboot auto-start) or remove it.
export type IpfsAutostartAction = "install" | "remove";

// ── Config health & guided self-repair (ipfs_ui.mdx §14) ─────────────────────
// Reading $IPFS_PATH/config and classifying it. This is what turns the incident — Kubo 0.42 FATAL-ing
// on a deprecated `Reprovider` key, mislabeled as a "timeout" — into a named, one-click-fixable state.
export type IpfsConfigIssueClass =
  | "missing" // no config file at all (repo never `ipfs init`-ed)
  | "unreadable" // exists but isn't valid JSON
  | "deprecated" // a deprecated key is present (e.g. Reprovider on Kubo ≥ 0.42) → the daemon crashes
  | "needs_migrate" // repo version behind the binary (`ipfs daemon --migrate`)
  | "noncompliant" // reprovide `all` / public gateway — only-our-content drift (knowledge/ipfs.mdx §6)
  | "suspicious"; // e.g. StorageMax unset, GC off — info only, never forced

export type IpfsIssueSeverity = "blocker" | "warn" | "info"; // blocker ⇒ IPFS can't run until fixed

// One config problem, with everything the UI needs to explain it and the user needs to consent to a fix.
export interface IpfsConfigIssue {
  id: string; // stable id passed back to POST /config-repair { issueIds }
  class: IpfsConfigIssueClass;
  severity: IpfsIssueSeverity;
  title: string; // plain-language one-liner
  detail: string; // what happened / why it matters
  keys: string[]; // the config keys involved (e.g. ["Reprovider"])
  changes: string[]; // plain-language list of what a fix WOULD change (shown before the click)
  fixable: boolean; // can we auto-fix it (confirm-then-apply)?
  manualSteps: string[]; // copyable manual commands/edits — the always-present escape hatch
}

// GET /api/ipfs/config-health — the whole config-health report (ipfs_ui.mdx §14.1).
export interface IpfsConfigHealth {
  checked: boolean; // we were able to look (the repo path is known)
  path: string; // $IPFS_PATH/config (e.g. ~/.ipfs/config)
  exists: boolean;
  readable: boolean; // parses as JSON
  healthy: boolean; // no blocker issues
  hasBlocker: boolean; // ≥1 blocker → IPFS cannot start until it's fixed
  issues: IpfsConfigIssue[];
}

// POST /api/ipfs/config-repair result (ipfs_ui.mdx §14.3) — always backs up before editing.
export interface IpfsConfigRepairResult {
  applied: string[]; // issue ids actually fixed
  skipped: string[]; // issue ids not auto-fixable / not requested
  backupPath: string | null; // config.bak.<unix-seconds> written before any edit
  health: IpfsConfigHealth; // fresh health after the repair
  node: IpfsNodeStatus; // fresh node status — did it come up now?
}

// ── Version / upgrade (ipfs_ui.mdx §15) ──────────────────────────────────────
// installedVersion vs a baked-in recommended baseline (network-free). `updateAvailable` is a
// best-effort LOCAL package-manager check ("a newer build exists") — null when we can't tell cheaply.
export interface IpfsUpgradeInfo {
  installedVersion: string | null; // parsed from `ipfs version`
  recommendedMin: string; // the baked-in baseline (authoritative for "too old to be safe")
  belowBaseline: boolean; // installedVersion < recommendedMin
  updateAvailable: boolean | null; // local pkg-mgr says a newer build exists; null = unknown
  canAutoUpgrade: boolean; // a package manager can run the upgrade on this machine
  upgradeCommand: string; // the copyable manual upgrade command
}

// GET /api/ipfs/liveness — the CHEAP app-wide summary the nudge banner polls (ipfs_ui.mdx §10/§17).
// Enough to pick the start-up scenario (not installed / not running / running-but-no-reboot-autostart)
// WITHOUT walking the pinset or reading metrics. All reads here are light (a PATH probe, an RPC id, a
// launchctl print, a config file read).
export interface IpfsLiveness {
  installed: boolean;
  running: boolean;
  autostartSupported: boolean;
  autostartEnabled: boolean;
  configBlocker: boolean; // a config issue is blocking start (ipfs_ui.mdx §14) → route to the fix
}

// GET /api/ipfs/node — the whole dashboard payload (ipfs_ui.mdx §11).
export interface IpfsNodeStatus {
  installed: boolean; // the `ipfs` CLI/daemon is present on this computer
  running: boolean; // the daemon answers RPC (health === "ok")
  version: string | null; // Kubo version, e.g. "0.29.0"
  peerId: string | null; // node identity
  repoPath: string | null; // IPFS_PATH / repo location (advanced)
  platform: IpfsPlatform; // drives the install path + manual command
  installMethod: string | null; // "brew" | "winget" | "snap" | null (no package manager found)
  installCommand: string; // the exact copyable manual command for this platform
  packageManagerPresent: boolean; // is the chosen package manager on PATH?
  metrics: IpfsNodeMetrics;
  gateway: IpfsGatewaySummary;
  // Only-our-content posture (mirrors IpfsNodeCard — knowledge/ipfs.mdx §6).
  reprovideStrategy: "pinned" | "roots" | "all";
  gatewayLocalOnly: boolean;
  publicGateway: boolean; // the deliberate opt-out setting (amber, not red)
  gcOn: boolean;
  compliant: boolean;
  autostart: IpfsAutostartStatus; // will IPFS come back on its own after a reboot? (ipfs_ui.mdx §13)
  configHealth: IpfsConfigHealth; // is the node config sane / repairable? (ipfs_ui.mdx §14)
  upgrade: IpfsUpgradeInfo; // installed version vs. recommended baseline (ipfs_ui.mdx §15)
}

// ── Install / start jobs — server-side, single-flight, re-attachable (ipfs_ui.mdx §7.2) ──
// All long IPFS actions share one job/progress view (ipfs_ui.mdx §16): install, start/stop the
// daemon, repair/migrate the config (§14), and upgrade the binary (§15).
export type IpfsJobKind = "install" | "start" | "stop" | "repair" | "upgrade";
export type IpfsJobPhase =
  | "idle"
  | "detecting"
  | "installing"
  | "initializing"
  | "starting"
  | "stopping"
  | "autostart" // setting up reboot auto-start after a successful start (ipfs_ui.mdx §13)
  | "repairing" // backing up + rewriting the config to fix a health issue (ipfs_ui.mdx §14.3)
  | "migrating" // running `ipfs daemon --migrate` for a repo-version bump (ipfs_ui.mdx §14.1)
  | "upgrading" // package-manager upgrade of the ipfs binary (ipfs_ui.mdx §15.2)
  | "done"
  | "error";

export interface IpfsInstallJob {
  kind: IpfsJobKind;
  status: "idle" | "running" | "done" | "error";
  phase: IpfsJobPhase;
  method: string | null; // package manager actually used (brew/winget/snap) or null
  log: string[]; // append-only, human-readable progress lines
  manualCommand: string | null; // the copyable fallback command (always set on error)
  error: string | null; // fatal message when status === "error"
  startedAt: string | null;
  finishedAt: string | null;
}

export type IpfsDaemonAction = "start" | "stop";

// POST /api/ipfs/daemon request — the on/off toggle. On `start`, the OPTIONAL `autostart` flag means
// "also set IPFS to come back automatically on reboot" — this backs the IPFS-off page's primary
// button (ipfs_ui.mdx §12). Omitted/false = turn on now WITHOUT touching the reboot auto-start setup.
export interface IpfsDaemonRequest {
  action: IpfsDaemonAction;
  autostart?: boolean;
}

// POST /api/ipfs/daemon result — either the fresh node status, or a job the UI should watch.
export interface IpfsDaemonResult {
  job: IpfsInstallJob | null; // set when the action runs as a progress job (start/stop)
  node: IpfsNodeStatus; // the (best-effort) node status right after kicking the action
}

// ── Peers (storage.mdx §11) ─────────────────────────────────────────────────
export interface PeerRow {
  id: string;
  label: string;
  ipfsPeerId: string | null;
  owner: string;
  lastSeen: string | null;
}

// ── Big-file threshold (settings.mdx §1) ────────────────────────────────────
export type SizeUnit = "MB" | "GB" | "TB";

export interface ThresholdDisplay {
  value: number;
  unit: SizeUnit;
}

// ── Global settings surface (settings.mdx) ──────────────────────────────────
// One of the user's own forge accounts (repo_company_mapping.mdx §4). `host` optional: absent ⇒ the owner
// matches on any known forge host; present ⇒ only on that host. A repo whose remote owner matches derives to
// Personal instead of a company.
export interface PersonalAccount {
  host?: string;
  owner: string;
}

export interface GlobalSettings {
  bigFile: {
    thresholdBytes: number;
    display: ThresholdDisplay;
  };
  scannerRoots: string[];
  ignoreGlobs: string[];
  // The user's own forge accounts (repo_company_mapping.mdx §4) — repos owned by these derive to Personal.
  personalAccounts: PersonalAccount[];
  ipfs: {
    apiAddr: string;
    gatewayAddr: string;
    reprovideStrategy: "pinned" | "roots" | "all";
    publicGateway: boolean;
    health: IpfsHealth;
    compliant: boolean; // does the running node honor only-our-content? (knowledge/ipfs.mdx §6)
  };
  allowedEmails: string[];
  access: SecurityAccess; // full allow-list (companies + individuals) — security.mdx §7.3
  // Mass-parallelization knob (parallelization.mdx §4 / settings.mdx §4.3). `maxCoreFraction` is the
  // fraction of CPU cores the mass-compute Core Budget may use for background compression & processing
  // (0.01–1, default 0.9 = 90%); `cores` is this machine's logical-core count (read-only) so the UI can
  // show the resolved budget, e.g. "≈ 14 of 16 cores".
  // `maxMemoryFraction` is concurrency's SECOND budget (memory.mdx §2.1 / performance.mdx P-28): the fraction
  // of the V8 heap ceiling that in-flight job payloads may reserve (0.05–1, default 0.5). `heapCeilingMB` is
  // this process's real `heap_size_limit` (read-only) so the UI can show the resolved budget, e.g. "≈ 3.0 GB
  // of 6.0 GB". This is the knob that governs how many AI descriptions may upload at once.
  performance: { maxCoreFraction: number; cores: number; maxMemoryFraction: number; heapCeilingMB: number };
}

// ── Security allow-list (security.mdx) ──────────────────────────────────────
// The two ways in: whole company domains, and/or exact individual Google accounts.
export interface SecurityAccess {
  allowCompanies: boolean; // "Allow anyone from these companies" checkbox
  allowedDomains: string[]; // bare Workspace domains, e.g. ["mycompany.com"]
  allowIndividuals: boolean; // "Individual Google accounts" checkbox
  allowedEmails: string[]; // exact emails, e.g. ["joesmith@gmail.com"]
}

// The setup POST body / admin PATCH body (security.mdx §7.2/§7.3).
export interface SecuritySetupInput {
  allowCompanies: boolean;
  domains: string[];
  allowIndividuals: boolean;
  emails: string[];
}

// Public, unauthenticated payload — NEVER carries the allow-list (security.mdx §8.3).
export interface SecurityConfigPublic {
  configured: boolean; // has first-run Security Setup completed? (drives the frontend gate)
  appName: string; // "Large File Bridge" — shown on the setup page (security.mdx §9)
}

export interface SecuritySetupResult {
  configured: boolean;
  // Retained for contract stability; now always false — the backend hot-rebuilds OAF's OIDC
  // pre-filter on every allow-list write, so no restart is ever needed (security.mdx §6.3).
  restartRecommended: boolean;
}

// Where a repo's transcripts / AI descriptions are written (placement_radios.mdx). A FROZEN wire enum:
//   • "lfbridge"  — the repo's hidden `.lfbridge/`, path-mirrored, ext appended (the default).
//   • "beside"    — next to the media file (the beside-media layout, reintroduced as an opt-in).
//   • "sync_repo" — the owning company/Personal LFB state-sync repo (only usable once one is configured;
//                   falls back to "lfbridge" until then).
export type PlacementChoice = "lfbridge" | "beside" | "sync_repo";

// ── Per-repo settings (repo_settings.mdx) ───────────────────────────────────
export interface RepoSettings {
  repoId: string;
  name: string;
  path: string;
  remote: string | null;
  pinned: boolean;
  bigFileOverride: {
    enabled: boolean;
    value: number;
    unit: SizeUnit;
  };
  largeFiles: {
    followGitignore: boolean;
    includeGlobs: string[];
    excludeGlobs: string[];
  };
  pin: {
    pinLocally: boolean;
    fetchMissing: boolean;
    publishManifest: boolean;
  };
  access: {
    shared: boolean;
    participants: string[];
  };
  // Company/personal mapping shown in the Ownership section (repo_settings.mdx §6 / repo_company_mapping.mdx).
  owner?: RepoOwner;
  // Where transcripts land (repo_settings.mdx §4 / placement_radios.mdx). Default "lfbridge".
  transcription: { placement: PlacementChoice };
  // Where AI descriptions land (repo_settings.mdx §5) — the mirror of transcription. Default "lfbridge".
  aiDescription: { placement: PlacementChoice };
  // Whether this repo additionally mirrors its Category-B tracking state to the owner's SYNC REPO so it
  // travels (repo_settings.mdx §2.9 / artifact_placement_policy.mdx §4). Default off; enabled only when the
  // owner has a sync repo configured.
  syncRepo: { enabled: boolean };
}

// ── Scheduled workers — the transparency contract (scan.mdx §7, storage.mdx §13)
export type WorkerKind = "scan" | "pin" | "device";

export interface WorkerState {
  kind: WorkerKind;
  installed: boolean;
  enabled: boolean;
  intervalSeconds: number;
  label: string;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  // Derived (backbone_resilience.mdx §7): true when the worker is installed + enabled but its last
  // successful run is older than 2× its interval (or it has never run) — the "an automatic job has
  // silently stalled" signal, distinct from off (disabled) and failed (ran with an error). Computed on
  // read, never stored.
  overdue: boolean;
}

// The live filesystem watcher (scan.mdx §2.2). NOT a scheduled worker — no plist/installed flag: it
// runs only while the web-app process is up. `enabled` is the persisted config switch; `watching` is
// whether it is actually bound to OS file-change events right now; `roots` is what it is watching.
export interface WatcherState {
  enabled: boolean;
  watching: boolean;
  roots: string[];
  pending: number;
}

export interface JobsPageData {
  scan: WorkerState;
  pin: WorkerState;
  device: WorkerState; // the every-10-min device-registration write-back (devices.mdx §12)
  watcher: WatcherState;
  computerLabel: string;
  ipfs: IpfsHealth;
  peers: PeerRow[];
}

// ── The on-demand scan job (scan.mdx §10) ───────────────────────────────────
// The discovery scan runs as a SERVER-SIDE background job, detached from the HTTP request that
// started it. Its live progress lives on the backend so the web app can poll it from ANY page and
// re-attach after the user navigates away and back. Never tied to a request lifecycle — closing the
// tab or leaving the Repos page does NOT cancel a scan.
export type ScanPhase = "idle" | "discovering" | "repos" | "computer" | "done";

export interface ScanJob {
  status: "idle" | "running" | "done" | "error";
  source: "manual" | "scheduled" | null;
  startedAt: string | null;
  finishedAt: string | null;
  phase: ScanPhase;
  reposTotal: number; // repo units this pass will scan (known after discovery)
  reposDone: number; // repo units finished so far
  currentUnit: string | null; // the unit being scanned right now (repo name or "computer")
  candidatesFound: number; // running total of big-file candidates recorded this pass
  error: string | null; // fatal error message when status === "error"
  ok: boolean | null; // did the last completed run finish without a fatal error?
  rerunQueued: boolean; // a Rescan arrived mid-run → one more pass will follow (single-flight)
}

// POST /api/repos/rescan → does not block on the walk; reports whether a fresh job started.
export interface RescanResult {
  started: boolean; // false when a scan was already running (this click was coalesced)
  job: ScanJob;
}

// ── Progress dock (webapp.mdx §10–§12) ──────────────────────────────────────
// The app-shell progress dock's operation taxonomy (webapp.mdx §11). One small card type; the VERB
// and any progress detail come from the job's kind. Both browser-initiated (optimistic) and
// server-side background-worker (launchd scan/pin) jobs flow through the same dock.
export type ProgressKind =
  | "scan"
  | "pin"
  | "publish"
  | "compress"
  | "transcribe"
  | "describe"
  | "hash"
  | "fingerprint"
  | "ignore"
  | "import"
  | "install"
  | "download" // large model-weights download (transcribe_engine.mdx §3.3 — the qwen provisioning download)
  | "configure"; // engine start / config-repair fixes (e.g. Start IPFS from a warning popup)

// One in-flight job as reported by GET /api/progress (server-side) or held optimistically in the
// browser. `done`/`total` are present only for DETERMINATE jobs (a bar is drawn); `unit` labels the
// numbers ("MB", "files", "%").
export interface ProgressJob {
  id: string;
  kind: ProgressKind;
  target: string; // repo name or file basename shown after the verb
  startedAt: string; // ISO
  done?: number; // determinate progress numerator
  total?: number; // determinate progress denominator
  unit?: string; // "MB" | "files" | "%" | …
}

// GET /api/progress → the union of all in-flight jobs (registry + the active discovery scan). `queued`
// is the background job queue's pending backlog (tasks waiting to start; job_queue.mdx §4) — the dock
// shows a "+ N queued" footer when it is > 0. Absent/0 means nothing is waiting.
export interface ProgressListResult {
  jobs: ProgressJob[];
  queued?: number;
  // Per-op pending breakdown (processing.mdx §5) — {transcribe, describe, compress} counts of not-yet-
  // started tasks, so the Processing page can label the backlog. Absent when nothing is waiting.
  queuedByOp?: Partial<Record<ProgressKind, number>>;
  // Background-processing batches (processing.mdx §4): active runs, plus recently-finished ones kept for
  // a short retention window so their error list is still visible if the user opens the page. Absent/empty
  // when there is nothing to show.
  batches?: ProcessingBatch[];
  // Worker utilization — the parallelism read (processing.mdx §3a): how many of the mass-compute Core
  // Budget's core-slots are BUSY right now (`busy`) vs the live budget total (`budget`, ≈ 90% of cores).
  // Lets the Processing page show "12 / 14 workers busy (~90% of cores)". Absent when nothing is running.
  workers?: { busy: number; budget: number };
  // PENDING items as rows for the per-item Processing table (processing.mdx §4.3) — the head of the queue
  // (capped, e.g. 500), so the user sees exactly what is waiting-but-not-started. Absent when idle.
  queuedItems?: QueuedItemView[];
  // Recently-FAILED items + reason (processing.mdx §4.3), kept through the retention window so failures stay
  // visible after the run — including a transcription that came back short of the full duration. Absent when
  // nothing failed.
  recentFailures?: FailedItemView[];
}

// One PENDING item (queued, not started) shown as a row on the Processing page's per-item table
// (processing.mdx §4.3.1). `kind` is audio/video/image where meaningful (transcribe/compress).
export interface QueuedItemView {
  op: ProgressKind;
  path: string;
  kind?: string | null;
  sizeBytes?: number;
}
// One recently-FAILED item (processing.mdx §4.3.1). For a truncated transcript the covered-vs-total seconds
// are carried so the table can show "covered 00:20:00 of 01:47:12" (transcribe_engine.mdx §4).
export interface FailedItemView {
  op: ProgressKind;
  path: string;
  reason: string;
  coveredSec?: number;
  durationSec?: number;
  at: string; // ISO
  // "halted" ≠ "failed" (to_fix.mdx §2.4/§7.3). A halted item was NEVER ATTEMPTED — the provider's circuit
  // opened (credits depleted, key revoked) and the queue dropped it rather than burn a doomed upload.
  // Rendering it as "failed" tells the user their files are bad when nothing was ever tried. Optional so
  // every existing producer keeps its meaning: absent = a real, attempted failure.
  state?: "failed" | "halted";
}

// The plan a producing PAGE ACTION returns (page_actions.mdx §5): after resolving scope (checked set or
// the recursive root) and dropping already-done + unsupported files, how many were background-queued.
// `willProcess` is the number the "{N} files will have their … created" toast shows (== queued).
export interface EnqueuePlan {
  considered: number; // set size after Rule 1 (checked set, or the recursive walk)
  eligible: number; // after Rule 2 — media that does NOT already have the output
  alreadyDone: number; // dropped because the output already exists
  unsupported: number; // dropped because not the right media kind
  queued: number; // handed to the background queue
  willProcess: number; // the number the toast shows (== queued)
  // First-time gate (Transcribe.mdx §3.5): true when EVERY eligible file needs setup (no Personal storage
  // owns them) — nothing was queued; the UI opens the setup wizard instead. `setupPath` is a representative
  // file to show in the wizard (null unless needsSetup).
  needsSetup: boolean;
  setupPath: string | null;
  // Provider-account gate (to_fix.mdx §2.5): true when a PREFLIGHT probe found the provider cannot serve
  // work right now — credits depleted, key revoked — so NOTHING was queued and the UI shows one actionable
  // banner instead of N failing cards. On 2026-07-15 a 1,440-file batch was queued 106 minutes after the
  // account died; every file was doomed before the first byte moved. This is the field that stops that.
  blocked: boolean;
  blockedReason: string | null;
}

// One eligible candidate file in a producing-action PREVIEW (dialogs.mdx §5.2 / page_actions.mdx §5).
export interface PreviewPlanFile {
  path: string; // absolute path
  sizeBytes: number; // 0 when the file can't be stat-ed
}

// The PREVIEW plan a producing PAGE ACTION returns (dialogs.mdx §5.2): the same Rule-1 (scope) + Rule-2
// (skip-already-done) narrowing as EnqueuePlan, but it QUEUES NOTHING — it returns the eligible candidate
// FILE LIST so the unified batch-confirm popup can list them checked-by-default. `files` are the eligible
// remainder (unsupported + already-done are dropped, only counted).
export interface PreviewPlan {
  files: PreviewPlanFile[]; // the eligible candidates (checked by default in the popup)
  considered: number; // set size after Rule 1 (checked set, or the recursive walk)
  alreadyDone: number; // dropped because the output already exists
  unsupported: number; // dropped because not the right media kind
}

// ── Web session activity ping (sessions.mdx) ────────────────────────────────
// Response to POST /api/sessions/activity. `newSession` is true when this ping STARTED a fresh web
// session (a return after the 4h idle window); `autoPinTriggered` is true when that start was on a
// > 48h-stale machine and a non-blocking pinAll() was fired.
export interface SessionActivityResult {
  newSession: boolean;
  autoPinTriggered: boolean;
  lastPinAt: string | null; // "last pinned" the staleness check read (ISO), or null if never
}

// ── Auth (mirrors @auth/backend AuthUser, trimmed) ──────────────────────────
export interface CurrentUser {
  authenticated: boolean;
  email: string | null;
  name: string | null;
  roles: string[];
  permissions: string[];
  allowListed: boolean;
}

// ── Auth / Google OAuth credentials setup (storage.mdx §10) ─────────────────
// Setup guidance surfaced to the UI when the creds file can't be found on this computer. Carries the
// expected path/filename and a PLACEHOLDER schema to create — never the secret values themselves.
export interface CredentialsFileInfo {
  configured: boolean; // clientId + clientSecret resolved (from file OR env)
  usingEnv: boolean; // resolved from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars
  exists: boolean; // the credentials file exists on disk
  path: string; // full expected path, e.g. ~/.credentials/large_files_bridge.json
  filename: string; // large_files_bridge.json
  directory: string; // ~/.credentials
  schemaExample: unknown; // JSON object shape to create (placeholder values)
}

export interface AuthConfig {
  oauthConfigured: boolean;
  devAuth: boolean;
  credentialsFile: CredentialsFileInfo;
  // The EXACT Google OAuth redirect URI to register on the Cloud client (webapp.mdx §3.2/§6) — the
  // GOOGLE_REDIRECT_URI default is built from the API port 8787, not the web port. Empty for a
  // non-loopback caller (redacted like the creds path). The remediation panel shows this verbatim.
  redirectUri: string;
  // The Google Workspace domain(s) a sign-in must be on (context in the panel — webapp.mdx §3.2).
  // Empty for a non-loopback caller.
  allowedDomains: string[];
}

// ── File System column browser (directory.mdx) ──────────────────────────────
// One code badge painted on a file/dir row. White letter on a solid color.
// Ordered rightmost-first when they stack: repo(R/r) · pin(P) · compress(C/c) · ipfs(i).
export type FsBadge =
  | "repo_root" // R  dark brown      (dir — its own .git working tree)
  | "repo_descendant" // r  medium brown    (file|dir inside a repo)
  | "repo_ancestor" // r  light brown     (dir that contains a repo below it)
  | "pin" // P  bright pink     (file whose decision === "sync" — the frozen add-to-IPFS wire value)
  | "compress" // C  bright yellow   (video/image file that looks uncompressed)
  | "compressed" // c  light yellow    (video/image file already compressed)
  | "ipfs" // i  blue            (IPFS list/share artifact, or dir publishing one)
  | "git_ignored"; // I  near-white     (file|dir that `git check-ignore` covers — directories.mdx §3.4a)

export type FsEntryKind = "dir" | "file" | "symlink" | "other";

// Interesting-directory folder coloring (file_system.mdx §2/§3.2). A directory's folder glyph is tinted
// by the HIGHEST-priority thing anywhere in its subtree: a big file (brown) beats a video (blue fill)
// beats an uncompressed image ≥ 3 MB (blue outline). `null` = not interesting (plain glyph); an ABSENT
// value (undefined on FsEntry.interest) = not-yet-known (budget-capped walk) → also plain, never a false
// "not interesting".
export type FolderInterest = "big" | "video" | "image" | null;

// Cloud-storage provider whose mount is surfaced at the top of the home column (file_system.mdx §6,
// dropbox.mdx / google_drive.mdx "browseable root" section). These live under
// ~/Library/CloudStorage/ on macOS and are lifted to the top level of the File System browser so the
// user can browse and compress the large files inside them without drilling Library → CloudStorage.
export type CloudProvider = "dropbox" | "google_drive" | "icloud";

// Marks a directory row as a surfaced cloud-storage root (file_system.mdx §6). Present ONLY on the
// synthetic/upgraded entries the home column lifts to its top; absent on every ordinary folder.
export interface CloudRootMark {
  provider: CloudProvider;
  account?: string; // the Google Drive account email (GoogleDrive-<account>); absent for Dropbox/iCloud
}

// One row in a column of the File System browser (directory.mdx §5).
export interface FsEntry {
  name: string;
  path: string; // absolute, server-normalized
  kind: FsEntryKind;
  sizeBytes: number | null; // files only
  modifiedAt: string | null; // ISO
  isRepoRoot: boolean;
  badges: FsBadge[]; // ordered rightmost-first (directory.mdx §3.5)
  hasChildren: boolean; // dir has ≥1 visible child (drives the disclosure)
  // Directories only: the interesting-folder tint level (file_system.mdx §3.2). Filled by the listing
  // endpoint's bounded subtree walk; may be absent when the walk budget was hit (render plain, upgrade later).
  interest?: FolderInterest;
  // Set ONLY on the cloud-storage roots the home column surfaces at its top (file_system.mdx §6). Drives
  // the cloud glyph + friendly label; `path` still points at the real mount so browsing is unchanged.
  cloud?: CloudRootMark;
}

// The contents of one directory level — one column of the browser.
export interface FsListing {
  root: string; // the absolute path this column lists
  parent: string | null; // for "up" navigation (null at a volume root)
  home: string; // the OS home dir (default root)
  entries: FsEntry[];
  truncated: boolean; // true if the per-column entry cap was hit (show the "narrowed" note; performance.mdx P-16)
}

// ── Full paths (flat large-file table under File System) — full_paths.mdx ─────
// A FLAT, recursive listing of the LARGE files (>= the big-file threshold) under a chosen root —
// the same FsEntry knowledge the column browser returns, gathered from every depth as one list.
export interface FlatFileListing {
  root: string; // absolute directory the walk was rooted at (server-normalized)
  home: string; // the OS home dir (the default root)
  thresholdBytes: number; // the big-file threshold that scoped this list (settings.mdx §1)
  files: FsEntry[]; // FILES only, gathered recursively; each carries badges (directory.mdx §5)
  truncated: boolean; // true if the file-cap / iteration budget was hit (show the "narrow root" note)
}

// ── Streaming flat listing (performance.mdx Part III, P-22/P-23) ──────────────
// The flat large-file walk is ALSO delivered as an NDJSON stream (GET /api/fs/flat/stream): one JSON
// object per line so the Full Paths table fills PROGRESSIVELY as the walk discovers rows, instead of
// the browser waiting on — then parsing + committing — one up-to-5000-row blob. `meta` arrives first
// (root/home/threshold), then `batch` events carry rows in chunks, then a single terminal `done`
// (or `error`). The non-streaming GET /api/fs/flat (FlatFileListing) remains for any buffered caller.
export type FlatStreamEvent =
  | { t: "meta"; root: string; home: string; thresholdBytes: number }
  | { t: "batch"; files: FsEntry[] }
  | { t: "done"; truncated: boolean; total: number }
  | { t: "error"; error: string };

// ── Git Ignore (the pop-over dialog + the .gitignore-writing engine) — git_ignore.mdx §5/§6 ──
// The dialog is plan-then-write: it holds a server-computed PLAN (the exact anchored, repo-root-relative
// lines grouped by owning repo, with already-ignored + not-in-repo targets removed) and Apply commits it.
// Exactly one of `paths` (the checked set) / `root` (a single directory) is used; neither is a 400.
export interface GitIgnoreRequest {
  paths?: string[]; // the checked target set (absolute paths)
  root?: string; // a single directory (used only when `paths` is absent)
  recursive: boolean; // directories: ON => whole folder "/<dir>/"; OFF => "/<dir>/*" + "!/<dir>/*/"
}

// The exact `.gitignore` lines to add for ONE owning repo (git_ignore.mdx §5.3).
export interface GitIgnoreRepoLines {
  repo: string; // absolute repo-root path whose root .gitignore receives the lines
  repoName: string; // basename of the repo root (for the "# <repo>/.gitignore" preview header)
  lines: string[]; // anchored, repo-root-relative lines (already-ignored + already-present removed)
}

// The plan the dialog previews (git_ignore.mdx §5) — POST /api/git/ignore/plan.
export interface GitIgnorePlan {
  files: number; // count of files in the target set (drives the summary shape)
  dirs: number; // count of directories in the target set (drives the Recursive checkbox)
  linesByRepo: GitIgnoreRepoLines[]; // the lines to write, grouped by owning repo
  alreadyIgnored: number; // target paths git already ignores (dropped from the plan)
  notInRepo: number; // target paths not inside any git repo (dropped from the plan)
}

// The synchronous Apply result (git_ignore.mdx §6) — POST /api/git/ignore/apply.
export interface GitIgnoreResult {
  written: number; // total `.gitignore` lines written across every touched repo
  repos: number; // count of repos whose .gitignore was appended to
  alreadyIgnored: number; // target paths git already ignored (nothing written for them)
  notInRepo: number; // target paths not inside any git repo (nothing written for them)
}

// Why an un-ignore could not be performed (git_ignore.mdx §5.5). Only `pattern-rule` and `foreign-source`
// are "the rule is not ours to touch" refusals the UI explains; the rest are benign no-ops.
export type UnignoreRefusal =
  | "not-ignored" // git already does not ignore it — the toggle is already off, nothing to do
  | "not-in-repo" // no owning git repo → the ignore axis does not apply
  | "pattern-rule" // a BROAD rule (e.g. `**/videos/**`) ignores it — removing it would un-ignore other files
  | "foreign-source" // the rule lives outside the repo's root .gitignore (.git/info/exclude, a global ignore)
  | "still-ignored" // our exact line was removable, but ANOTHER rule still ignores it → we rolled back
  | "write-failed"; // the .gitignore could not be rewritten

// The result of trying to un-ignore ONE path (git_ignore.mdx §5.5) — POST /api/git/ignore/remove.
export interface UnignoreOutcome {
  path: string; // the absolute path asked about
  removed: boolean; // true = git no longer ignores this file (our exact anchored line was removed)
  refusal?: UnignoreRefusal; // why not, when `removed` is false
  // The rule that ignores (or still ignores) the file, verbatim from `git check-ignore -v`, so the UI can
  // name it: "Ignored by .gitignore:3 — `**/videos/**`". Null when the file simply is not ignored.
  rule?: { source: string; line: number; pattern: string } | null;
}

// ── Single-entity views + sticky flags (menus.mdx §6.6, files.mdx, directories.mdx) ──
// Two persistent per-entity flags the user sets from the ⋯ / right-click menu or the entity page.
// They apply to a file OR a directory (a directory's flag covers everything under it), survive
// rescans, and NEVER delete or alter local bytes.
export interface FileFlags {
  neverIpfs: boolean; // never add to IPFS / pin this entity (forbids the Add-to-IPFS "sync" decision)
  noCompress: boolean; // suppress the "should compress" (C) offer/badge for this entity
}

// Rollup of what's inside a directory — the charter's count+category table (directories.mdx §2/§3).
export interface DirRollup {
  videosToCompress: number; // category 1
  imagesToCompress: number; // category 2
  bigNotIgnored: number; // category 3 — big files that aren't git-ignored
  bigIgnoredNotTracked: number; // category 4 — big git-ignored files we don't yet track
  entryCount: number; // immediate children (files + dirs)
  scannedAt: string | null;
  // The interesting-folder tint level for THIS directory's subtree (file_system.mdx §3.2), a by-product
  // of the same bounded rollup walk. `undefined` when the walk budget was hit before a conclusion.
  interest?: FolderInterest;
}

// The single-entity payload for View-one-file / View-one-directory (files.mdx §2, directories.mdx §3).
export interface EntityView {
  kind: "file" | "dir";
  name: string;
  path: string; // absolute, server-normalized
  exists: boolean;
  sizeBytes: number | null; // file bytes (dir: rolled-up total or null)
  createdAt: string | null;
  modifiedAt: string | null;
  badges: FsBadge[]; // same vocabulary/order as directory.mdx §3
  flags: FileFlags;

  // Repo / pin context — populated only when the entity is inside a REGISTERED repo.
  repo: { repoId: string; name: string; relPath: string } | null;
  decision: Decision | null; // null when not in a repo (files.mdx §2)
  transfer: TransferStatus | null;
  cid: string | null;
  peers: string[];

  // Compression heuristic (directory.mdx §3.3) — drives the Compression card / rollup.
  compressible: "video" | "image" | null;
  compressState: "should" | "done" | null;

  rollup: DirRollup | null; // dirs only (directories.mdx §3)
}

// PATCH body for the two sticky flags (partial — omit a field to leave it unchanged).
export interface EntityFlagsPatch {
  path: string;
  neverIpfs?: boolean;
  noCompress?: boolean;
}

// ── Media viewer (media_viewer.mdx §2) ──────────────────────────────────────
// Which viewer a file opens in. Non-media files fall back to the /file properties page.
// Audio joins image/video as a viewer-first kind (the /audio player) — media_viewer.mdx.
export type MediaKind = "image" | "video" | "audio";

// Best-effort, LOCAL-ONLY, NO-SHELL probe of a media file (media_viewer.mdx §2). Every field is
// nullable: the sniff reads a bounded header/tail and reports only what it can determine. The viewer
// never blocks on this — the bytes stream from the signed grant URL regardless.
export interface MediaProbe {
  kind: "image" | "video" | "audio" | "other"; // from the extension family
  container: string | null; // "MP4" | "QuickTime" | "Matroska" | "WebM" | "PNG" | "JPEG" | …
  codec: string | null; // "H.264" | "HEVC" | "AV1" | "VP9" | "ProRes" | "PNG (lossless)" | …
  width: number | null; // pixels — parsed for images; videos when cheaply available
  height: number | null;
  compressState: "should" | "done" | null; // mirrors the C/c heuristic (badges.ts compressInfo)
}

// The signed, short-lived grant a media element loads from (media_viewer.mdx §2).
export interface MediaGrant {
  url: string; // e.g. "/api/media/raw?path=…&e=<expMs>&t=<hmac>" — same-origin, Range-capable
}

// ── Compression (compression.mdx) ───────────────────────────────────────────
export type CompressQuality = "low" | "medium" | "high" | "lossless";
export type CompressMedia = "images" | "video" | "audio";

// Per-media codec preferences (compression.mdx §7) + file-type conversion policy (images.mdx §2).
export interface CompressMediaPrefs {
  enabled: boolean;
  quality: CompressQuality;
  prefer: string[]; // ordered target codecs; first allowed+available wins
  deny: string[];   // codecs the user never wants chosen
  convertTypes: boolean; // may a compress CHANGE the format (HEIC→JPEG…)? false = format-preserving
  skipExts: string[];    // per-extension OPT-OUT (lowercase, leading-dot); [] = every ext in scope
}
export interface CompressionSettings {
  images: CompressMediaPrefs;
  video: CompressMediaPrefs;
  audio: CompressMediaPrefs;
  preserveResolution: boolean; // LOCKED on — never downscale (compression.mdx §5)
  replaceOriginalToTrash: boolean; // recoverable replace (compression.mdx §8)
}

// Which brew tools are on PATH (compression.mdx §2).
export interface CompressTools {
  ffmpeg: boolean;
  ffprobe: boolean;
  magick: boolean; // ImageMagick (magick or convert)
  oxipng: boolean;
  cwebp: boolean;
  cjpeg: boolean; // mozjpeg
  jpegoptim: boolean;
  heif: boolean; // ImageMagick libheif delegate / heif-dec — required to read HEIC/HEIF/AVIF (images.mdx §4.1)
}

// The dry-run plan + safety verdict for a file (compression.mdx §3/§6) — drives the pre-compress warning.
export interface CompressCheck {
  path: string;
  media: CompressMedia | null; // null = not a compressible media file
  eligible: boolean;           // media type enabled + a tool available + not already best
  action: string;              // human summary, e.g. "PNG → JPEG (medium)" / "lossless PNG recompress"
  targetCodec: string | null;
  alphaUsed: boolean | null;   // null = undeterminable
  alphaSafe: boolean;          // false → would drop used transparency (blocked)
  warning: string | null;      // e.g. "converting would lose transparency"
  toolMissing: string | null;  // a required tool that isn't installed
}

// The result of compressing one file (compression.mdx §8).
export interface CompressResult {
  path: string;               // final path (may have a new extension after a format conversion)
  status: "compressed" | "skipped" | "blocked" | "failed";
  reason: string | null;      // why skipped/blocked/failed
  beforeBytes: number | null;
  afterBytes: number | null;
  codec: string | null;       // the codec the output was written with
}
export interface CompressBatchResult {
  results: CompressResult[];
}

// ── Compress videos & images inside a directory (compress_inside.mdx) ─────────
// What happens to each ORIGINAL after its file compresses successfully. This is a PER-RUN choice made
// in the "Compress inside" dialog and it OVERRIDES the global recoverable-by-default (compression.mdx
// §8 / charter): "hard" = unlink the original; "trash" = move it to the recoverable LFBridge trash.
// The dialog DEFAULTS to "hard" (the user asked for that on this explicit bulk action). Deletion is
// PER-FILE and only ever happens AFTER that one file's temp output verified — a mid-file failure never
// deletes its original (compress_inside.mdx §4).
export type DeleteOriginalMode = "hard" | "trash";

// POST /api/compress/inside body — the dialog's four inputs plus the directory root (compress_inside.mdx §3).
export interface CompressInsideRequest {
  root: string;                    // the directory whose media to compress (the triple-dot menu's dir)
  images: boolean;                 // include image files
  videos: boolean;                 // include video files
  recursive: boolean;              // descend into sub-directories (dialog default: true)
  deleteOriginal: DeleteOriginalMode; // dialog default: "hard"
}

// The plan the enqueue returns immediately (compress_inside.mdx §5) — it never waits for the work. The
// eligible files are handed to the background queue as `compress` tasks grouped under `batchId`.
export interface CompressInsidePlan {
  batchId: string;   // the ProcessingBatch grouping these tasks (processing.mdx §4)
  considered: number; // files the walk saw (of the selected kinds)
  eligible: number;   // media that should compress (not already-done, not flagged Do-not-compress)
  queued: number;     // handed to the queue (== eligible)
  images: number;     // eligible breakdown
  videos: number;
}

// ── Background processing batches (processing.mdx §4) ────────────────────────
// A batch groups the per-file tasks of ONE bulk action (today: a "Compress inside" run) so the
// Processing page can show one progress bar + the final ERROR LIST for that run. Individual running
// files still surface their own dock cards via the registry; the batch is the roll-up around them.
export interface ProcessingBatchError {
  path: string;    // the file that failed/was blocked
  reason: string;  // why (ffmpeg error, blocked-alpha, no-gain-is-not-an-error, …)
}
export interface ProcessingBatch {
  id: string;
  kind: ProgressKind;              // "compress" for now
  label: string;                  // e.g. "Compress inside ~/Movies/Trip"
  total: number;                  // eligible files in the run
  done: number;                   // finished OK (compressed or skipped-no-gain)
  failed: number;                 // finished with an error/blocked (each also in `errors`)
  errors: ProcessingBatchError[]; // the list shown when the run finishes (compress_inside.mdx §4)
  deleteOriginal: DeleteOriginalMode; // how originals were disposed (shown for transparency)
  startedAt: string;              // ISO
  finishedAt: string | null;      // ISO once total === done + failed; null while running
}

// ── Transcribe (Transcribe.mdx) ─────────────────────────────────────────────
// Which underlying binaries the transcription engine needs are installed (§6 GET /transcribe/tools).
export interface TranscribeTools {
  whisper: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
}

// ── Transcription engine + heavyweight-model provisioning (transcribe_engine.mdx) ────────────────────
// The engine identity, in preference order (best first — NEVER the legacy Apple SFSpeechRecognizer):
//   `speech` = Apple SpeechAnalyzer / SpeechTranscriber (macOS 26+, on-device — the NEW primary; its model
//              ships in the OS, no multi-GB download); `mac` = OpenAI Whisper at the `small` model (MPS→CPU,
//              the cross-platform SECOND choice); `qwen` = Qwen3-ASR via Apple MLX (the `mlx-qwen3-asr` CLI
//              at Qwen/Qwen3-ASR-1.7B — the heavyweight, multi-GB-download engine, Apple-Silicon only), now
//              the THIRD choice / "another LLM" and NOT auto-selected. Auto picks speech when available, else
//              mac. A run auto-falls-back down the order speech → mac → qwen on error (§2.1).
export type TranscribeEngineId = "qwen" | "mac" | "speech";
// Readiness of the heavyweight (`qwen`) model on this machine (transcribe_engine.mdx §3.1). `unsupported` =
// not an Apple-Silicon Mac, so `qwen` can never run here and selection falls to `mac`.
export type TranscribeModelReadiness = "installed" | "missing" | "partial" | "outdated" | "unsupported";
// GET /api/transcribe/engine — engine + heavyweight-model readiness. Drives the consent popup (§3.2) and
// the Settings → Transcription panel (§6).
export interface TranscribeEngineStatus {
  active: TranscribeEngineId; // which engine pickEngine() would use right now
  configured: "auto" | TranscribeEngineId; // the transcribe.engine setting
  consent: "approved" | "declined" | "use_fallback" | null; // remembered popup decision (§3.2); null = never asked
  appleSilicon: boolean; // qwen is only available on Apple Silicon
  // Apple SpeechAnalyzer readiness (the NEW primary — macOS 26+, on-device, no download). `needsOsUpdate`
  // = Mac hardware that COULD run SpeechAnalyzer but the OS is older than macOS 26, so we fell back to
  // Whisper Small and the UI nudges a macOS update (transcribe_engine.mdx §1).
  speech: {
    available: boolean; // SpeechAnalyzer usable right now (darwin + macOS ≥ 26 + swiftc to build the helper)
    osMajor: number | null; // macOS product major (26 = Tahoe), or null off-Mac / unreadable
    needsOsUpdate: boolean; // Apple-Silicon hardware, but OS < 26 → update recommended, fell back to Whisper Small
    hardwarePossible: boolean; // Mac hardware that could run SpeechAnalyzer once the OS is new enough
  };
  qwen: {
    cliInstalled: boolean; // mlx-qwen3-asr on PATH
    readiness: TranscribeModelReadiness;
    installedBytes: number | null; // measured on-disk size of the weights once present
    estimateBytes: number; // ballpark→stored disk estimate for a fresh install
    freeDiskBytes: number; // free space where the model would live
    model: string; // "Qwen/Qwen3-ASR-1.7B"
  };
  whisper: { installed: boolean }; // the fallback CLI (openai-whisper)
  ffmpeg: boolean; // required for video demux
}
// POST /api/transcribe/engine/provision — the two-phase provisioning outcome (transcribe_engine.mdx §3.3):
// a `download`/`install` job pair is registered; this is what the request returns immediately.
export interface TranscribeProvisionResult {
  started: boolean; // false when nothing to do (already installed) or unsupported hardware
  reason: string | null; // why not started (already-installed / unsupported / declined)
}
// The result of transcribing one media file (Transcribe.mdx §1). transcriptPath = the sidecar written
// beside the media at <root>/<relpath-without-ext>.transcription (§3).
export interface TranscribeResult {
  path: string;               // the media file transcribed
  // "needs_setup" — no Personal storage exists and the file is owned by nothing, so placement would be
  // surprising; the action is redirected to the first-time setup wizard instead (Transcribe.mdx §3.5).
  status: "transcribed" | "skipped" | "no_audio" | "tool_missing" | "failed" | "needs_setup";
  transcriptPath: string | null;
  words: number | null;       // word count of the transcript body (success only)
  reason: string | null;      // why skipped / no_audio / tool_missing / failed / needs_setup
}

// ── derived-artifact placement (Transcribe.mdx §3.4–§3.5) ───────────────────────────────────────────
// Which root a media file's sidecar artifacts (<relNoExt>.transcription / .ai_description) will be mirrored
// under, and whether the first-time setup wizard must run first. GET /api/storages/placement?path=<media>
// returns it, so an action can show/decide WHERE its output lands before running.
export interface ArtifactPlacementView {
  mediaPath: string;                 // the home-expanded absolute media path resolved
  root: string;                      // the storage/repo/dedicated-repo/dir the mirrored sidecars hang under
  rel: string;                       // the media path relative to root (mirrored, then ext-replaced)
  transcriptPath: string;            // <root>/<rel-without-ext>.transcription (the concrete transcript destination)
  gitIgnore: boolean;                // false inside a dedicated repo (it exists to hold these artifacts)
  owner: "repo" | "storage-root" | "dedicated-repo" | "beside";
  needsSetup: boolean;               // true → route to the first-time setup wizard (§3.5)
}
// A tree / batch / storage run — the per-file results plus honest counts (Transcribe.mdx §6).
export interface TranscribeBatchResult {
  results: TranscribeResult[];
  transcribed: number;
  skipped: number;
  failed: number;
}
// An existing transcript read back for a media file (Transcribe.mdx §6 GET /transcribe/file).
export interface TranscriptView {
  mediaPath: string;
  transcriptPath: string;
  text: string;
}

// ── OS hand-off (os_open.mdx) ───────────────────────────────────────────────
// GET /api/fs/platform — what the "Open on {label}" buttons need. `os` is the host family; `label` is
// the word the button shows ("Mac" | "PC" | "Linux"); `canOpenInOS` is true only when hand-off is
// possible here (backend in local mode + a loopback request).
export interface PlatformInfo {
  os: "mac" | "windows" | "linux" | "other";
  label: string;
  canOpenInOS: boolean;
}
// POST /api/fs/os-open result — the file/folder handed to the host OS default handler.
export interface OsOpenResult {
  opened: boolean;
  path: string;
  isDir: boolean;
  via: string; // the platform label used ("Mac"/"PC"/"Linux")
}

// ── AI description (ai_description.mdx) ──────────────────────────────────────
// Only images and videos are AI-described (audio is covered by transcription).
export type DescribeKind = "image" | "video";

// One vision provider the app can call (ai_description.mdx §5). `available` = an API key is resolvable
// on this machine (config or env); `supports` = which media kinds this provider can describe.
export interface DescribeProvider {
  id: "gemini" | "grok" | "openai";
  label: string;
  available: boolean;
  supports: MediaKind[];
  usingFile?: boolean; // Gemini only: the resolved key came from the shared GoogleCloud/apikey.yaml
}
// GET /api/describe/providers — the provider matrix + whether any provider is usable at all.
export interface DescribeProvidersStatus {
  providers: DescribeProvider[];
  defaultProvider: string; // "auto" | a provider id
  anyAvailable: boolean;
}
// An existing generated description read back for a media file (GET /api/describe/file).
export interface DescribeView {
  mediaPath: string;
  descriptionPath: string; // the sidecar beside the media at <root>/<rel-without-ext>.ai_description
  text: string; // the human-readable description body
  model: string | null; // the model id used (e.g. "gemini-flash-latest")
  generatedAt: string | null; // ISO
}
// The result of generating one description (POST /api/describe/file). Reports truthfully per file.
export interface DescribeResult {
  path: string;
  // "needs_setup" — mirrors TranscribeResult: no Personal storage exists and the file is owned by
  // nothing, so the first-time setup wizard must run first (Transcribe.mdx §3.5, ai_description.mdx §2).
  status: "described" | "skipped" | "no_provider" | "unsupported" | "failed" | "needs_setup";
  descriptionPath: string | null;
  model: string | null;
  reason: string | null;
}
// A batch / tree run of AI description — the per-file results plus honest counts (mirrors
// TranscribeBatchResult; ai_description.mdx §5 POST /describe/batch|/tree).
export interface DescribeBatchResult {
  results: DescribeResult[];
  described: number;
  skipped: number;
  failed: number;
}
// The per-kind prompt as the settings/viewer surface sees it (GET /api/describe/prompt).
export interface DescribePromptView {
  kind: DescribeKind;
  text: string;
  isOverride: boolean; // true = a per-computer edited copy is in use; false = the shipped default
  path: string; // where the in-use prompt lives (override path or the shipped default)
}

// The editable AI config the global Settings page reads/writes (GET/PATCH /api/describe/config). The
// raw API key is NEVER returned — only whether one is configured, and from where (config vs env).
export interface DescribeAiProviderConfig {
  id: "gemini" | "grok" | "openai";
  label: string;
  supports: MediaKind[];
  model: string;
  hasConfigKey: boolean; // a key is stored in config.yaml for this provider
  usingEnv: boolean; // no config key, but a matching env var is present
  usingFile: boolean; // no config/env key, but the shared GoogleCloud key file supplies one (Gemini only)
  available: boolean; // a usable key resolves (config OR env OR shared file)
}
export interface DescribeAiConfig {
  provider: "auto" | "gemini" | "grok" | "openai"; // the default provider ("auto" = first available)
  providers: DescribeAiProviderConfig[];
}

// GET /api/describe/credentials — everything the "AI credentials" instructions page needs to tell the
// user WHERE to put a Gemini key and in WHAT format. Powers the "Instructions" button of the
// credentials-missing popup (ai_credentials.mdx). The raw key VALUE is never included.
export interface AiCredentialsFileInfo {
  path: string; // absolute path to the shared GoogleCloud/apikey.yaml
  filename: string; // "apikey.yaml"
  directory: string; // the containing directory
  fields: string[]; // the YAML fields we read, in priority order (["apiKey", "4k_apiKey"])
  exists: boolean; // a file is already present at that path
  configured: boolean; // the file yields a usable (non-placeholder) key
  schemaExample: string; // a PLACEHOLDER YAML template to fill in (no real secret)
}
export interface AiCredentialsInfo {
  anyAvailable: boolean; // any provider (any source) is usable right now
  file: AiCredentialsFileInfo; // the shared GoogleCloud/apikey.yaml key file
  appConfigPath: string; // the app config.yaml Settings → Tools writes keys into
  envVars: { gemini: string[]; grok: string[]; openai: string[] }; // the env vars each provider honors
}
// PATCH body — apiKey "" clears the config key (falls back to env); undefined leaves it unchanged.
export interface DescribeAiProviderPatch {
  apiKey?: string | null;
  model?: string;
}
export interface DescribeAiConfigPatch {
  provider?: "auto" | "gemini" | "grok" | "openai";
  gemini?: DescribeAiProviderPatch;
  grok?: DescribeAiProviderPatch;
  openai?: DescribeAiProviderPatch;
}

// ── Storages (storages.mdx) ─────────────────────────────────────────────────
// The family of large-file storages. "local" is settings/config (the DB replacement, storage_local.mdx);
// the other four are directory hierarchies with a storage.yaml + hidden .lfbridge/ (storages.mdx §1).
export type StorageType = "local" | "repo" | "personal" | "company" | "community";

// Where, if anywhere, a storage's hierarchy is also mirrored (storages.mdx §5). null = not mirrored.
export interface StorageClones {
  googleDrive: string | null;
  dropbox: string | null;
}

// The `storage.yaml` descriptor at a directory-based storage's root (storages.mdx §3). Exactly one
// type-specific block is populated, matching `type`.
export interface StorageDescriptor {
  name: string;
  type: StorageType;
  created: string | null;
  company: { companyName: string; [k: string]: unknown } | null;
  community: { id: string; role: "download" | "share" | "support"; [k: string]: unknown } | null;
  personal: Record<string, unknown> | null;
  repo: { repoRoot: string } | null;
  clones: StorageClones;
}

// One storage as the Storages page / left-bar tab sees it (storages.mdx §2).
export interface StorageRow {
  id: string;              // stable id: "personal" · "local" · community id · a path hash for companies
  name: string;
  type: StorageType;
  root: string;            // absolute root dir ("" for local)
  companyName: string | null;
  communityId: string | null;
  initialized: boolean;    // has a storage.yaml (false = a detected candidate not yet set up)
  hasLfbridge: boolean;    // has the hidden .lfbridge/ tracking area
  fileCount: number | null;// large files in the fingerprint index (null until indexed)
  clones: StorageClones;
  route: string;           // where the row / left-bar child links
}

// GET /api/storages — the Storages tab/page payload (storages.mdx §2). Repos are represented by a link,
// not a list (the Repos tab owns the long list — storage_repo.mdx §5).
export interface StoragesPageData {
  local: StorageRow;
  personal: StorageRow | null;
  companies: StorageRow[];
  communities: StorageRow[];
  repos: { count: number; route: string };
}

// ── Communities (communities.mdx) ───────────────────────────────────────────
// A community is a publisher of large PUBLIC files a user can subscribe to. Subscribing carries an
// INTENT (Get and/or Support) and a BACKUP MODE (Block · Recommended · Full). Rebroadcasting stays
// charter-compliant: an explicit, per-community opt-in that pins a chosen publisher's public files —
// never a general public gateway/relay (communities.mdx §1).
export type CommunityBackupMode = "block" | "recommended" | "full";

// The per-community subscription choices (communities.mdx §3–§4). Persisted computer-wide under
// `pin/c/<community_id>/config.yaml`.
export interface CommunitySubscription {
  get: boolean;       // intent: consume the videos for yourself (§3)
  support: boolean;   // intent: rebroadcast/pin to keep the community secure (§3)
  backupMode: CommunityBackupMode; // Block · Recommended · Full (§4), default Block
  bookmarked: boolean;             // leading bookmark toggle (tables.mdx §1)
}

// The rolled-up library of one community (communities.mdx §2 `library`/`totals`).
export interface CommunityLibrary {
  items: number;      // total files
  videos: number;
  images: number;
  totalBytes: number; // sum of the library's file sizes
}

// One community as the Communities table sees it (communities.mdx §7).
export interface CommunityRow {
  id: string;                 // stable slug — primary key + URL (communities.mdx §2)
  name: string;
  publisher: string | null;
  description: string | null;
  root: string;               // the on-disk community storage root (storage_community.mdx)
  library: CommunityLibrary;
  subscription: CommunitySubscription;
  keepingSecureBytes: number; // bytes currently pinned for this community
  targetBytes: number;        // its target (recommended amount, or full-library size)
  redundancy: number | null;  // known pinners already carrying it (null = unknown)
}

// The storage math header (communities.mdx §5/§6) — measured from the real state-root volume.
export interface CommunityStorageMath {
  totalDiskBytes: number;         // capacity of the volume the state root lives on (§5.1)
  freeOutsideIpfsBytes: number;   // free space genuinely available, excluding the IPFS datastore (§5.1)
  reservedHeadroomBytes: number;  // the floor we never cross (§5.1)
  communityBudgetBytes: number;   // the amount devoted to ALL community content combined (§5.2)
  recommendedBudgetBytes: number; // proposal = free_outside_ipfs − headroom, then a sensible fraction (§5.2)
  usedBytes: number;              // bytes currently pinned across all communities (meter numerator, §6)
}

// GET /api/communities — the Communities page payload (communities.mdx §6).
export interface CommunitiesPageData {
  math: CommunityStorageMath;
  communities: CommunityRow[];
}

// PATCH /api/communities/:id — partial update of one community's subscription (communities.mdx §3–§4).
export interface CommunitySubscriptionPatch {
  get?: boolean;
  support?: boolean;
  backupMode?: CommunityBackupMode;
  bookmarked?: boolean;
}

// GET /api/storages/:id — one storage's detail: its descriptor + the tracked files.
export interface StorageDetail {
  storage: StorageRow;
  descriptor: StorageDescriptor | null;
  files: StorageFileRow[];
}

// One row of a storage's .lfbridge/files.yaml fingerprint index (storages.mdx §4.1).
export interface StorageFileRow {
  path: string;            // relative to the storage root
  sizeBytes: number;
  modifiedAt: string | null;
  createdAt: string | null;
  fingerprint: string | null;
  compressible: "video" | "image" | null;
  analysis: string[];      // which §6 outputs exist: "transcript" | "description" | "visuals_by_time"
}

// POST /api/storages/:id/index — result of (re)building the fingerprint index.
export interface StorageIndexResult {
  indexed: number;
}

// POST /api/storages/:id/analyze — result of queuing media analysis for one file (storages.mdx §6).
export interface StorageAnalyzeResult {
  path: string;
  outputs: string[];       // which analysis YAMLs were written/queued
}

// ── Mapped source directories (syncable_data_location.mdx §3) ────────────────
// The SHARED list of source directory hierarchies a company/personal storage covers. `canonical` is the
// writer's path — advisory only; a reader re-roots each key via its own device graft (devices.mdx §4).
export interface MappedDir {
  key: string; // stable id, referenced by every device's graft
  label: string; // human name shown in the UI
  canonical: string | null; // the WRITER's path — advisory only
  recursive: boolean; // the whole subtree is in scope (always true today)
}
export interface MappedDirList {
  schemaVersion: number;
  mapped: MappedDir[];
}

// One mapped-directory ROW as the storage settings page (§4a) shows it: the SHARED logical entry joined
// with THIS computer's graft (devices.mdx §4) — so the user edits the shared list (add/remove) and this
// machine's local path (the graft) in one row.
export interface MappedDirRow {
  key: string;
  label: string;
  canonical: string | null; // the writer's advisory path (shared)
  recursive: boolean;
  localPath: string | null;  // THIS device's grafted absolute path (null = not grafted here)
  wanted: boolean;           // does this device carry this hierarchy at all
}
// GET /api/storages/:id/mapped-dirs — the mapped-directory list joined with this device's graft (§4a).
export interface MappedDirsView {
  storageId: string;
  // false for repo/local: a repo's single mapped dir (its working tree) is shown read-only; the list is
  // editable only for company/personal storages.
  editable: boolean;
  rows: MappedDirRow[];
}
// PATCH /api/storages/:id/mapped-dirs — set the SHARED list (add/remove rows) and/or THIS device's graft
// paths. `mapped` replaces the shared list; `graft` maps a row key → this computer's local path.
export interface MappedDirsPatch {
  mapped?: Array<Partial<MappedDir>>;
  graft?: Record<string, string | null>;
}

// ── Devices — the per-computer registry + the graft (devices.mdx) ────────────
export interface DeviceScheduleWindow {
  days: string[];
  from: string;
  to: string;
}
export interface DeviceSchedule {
  enabled: boolean;
  intervalMinutes: number;
  windows: DeviceScheduleWindow[];
}
// One graft entry: how THIS device re-roots one mapped-dir key onto a local path (devices.mdx §4).
export interface DeviceGraftEntry {
  localPath: string | null; // where THIS computer keeps this mapped dir (null = known-but-absent here)
  wanted: boolean; // does this device want this hierarchy at all
}
// The hardware fingerprint that identifies a physical computer (devices.mdx §7). camelCase mirror of
// DeviceHardwareSchema. Collected locally (no network); travels in each device file so other computers
// can identify & disambiguate this one.
export interface DeviceHardware {
  platform: string; // darwin | linux | win32
  kind: string; // laptop | desktop | server (derived)
  hostname: string;
  username: string; // logged-in OS user
  homeDir: string; // the ~ dir — which user this machine belongs to
  modelIdentifier: string; // hw.model, e.g. Mac14,7
  modelName: string; // "MacBook Pro"
  marketingName: string; // "MacBook Pro (14-inch, 2023)" — "" if unknown
  year: number | null;
  chip: string; // "Apple M2 Pro"
  arch: string; // arm64
  cpuCores: number | null;
  ramGb: number | null;
  diskTotalGb: number | null;
  screenInches: number | null; // built-in display size
  screenCount: number | null;
}
// One device file `<SDL>/.lfbridge/devices/<device>.yaml` (devices.mdx §3) — self-owned per device.
export interface DeviceRecord {
  schemaVersion: number;
  updatedAt: string | null;
  device: {
    id: string; // the minted UUID — matches config.yaml→computer.id
    name: string; // the nice name the user set
    owner: string | null; // the allow-listed user this computer belongs to
    ipfsPeerId: string | null; // for peer dialing (may change; id above does not)
    hardware: DeviceHardware; // the fingerprint (devices.mdx §7)
  };
  schedule: DeviceSchedule;
  graft: Record<string, DeviceGraftEntry>; // keyed by mapped_dirs.yaml key
}

// One row in the Devices / Peers table (devices.mdx §6). The aggregate the page shows: this computer
// (always injected — the table is never empty), the machine-local peers.yaml, and the travelling
// devices/ registry across every storage, unioned by device id and disambiguated.
export interface DeviceRow {
  id: string; // device UUID (or the peers.yaml id when only a peer entry exists)
  name: string; // the nice name
  displayLabel: string; // the disambiguated label (device-naming.ts) — name + only the differing attrs
  isSelf: boolean; // is this THIS computer? (matches config.yaml→computer.id)
  owner: string | null;
  ipfsPeerId: string | null;
  lastSeen: string | null;
  hardware: DeviceHardware | null; // null for a bare peers.yaml entry with no fingerprint yet
  storageCount: number; // how many storages' registries list this device
  source: "self" | "registry" | "peer"; // where the row was sourced from
}

// ── Bookmarks (syncable_data_location.mdx §4.4) — travel with the storage ─────
export interface BookmarksResult {
  storageId: string;
  bookmarked: string[]; // relpaths, relative to the storage root / mapped dir
}

// ── Compression record (syncable_data_location.mdx §4.3) — travels in the SDL ─
export interface CompressionRecord {
  source: string; // the CURRENT (compressed) path, relative to the storage root
  original: { name: string; extension: string; size: number };
  compressed: { codec: string | null; size: number; ratio: number; at: string };
}

// ── Per-storage settings (storage_settings.mdx) ─────────────────────────────
// One backing location (dedicated repo / Google Drive / Dropbox) as the settings page sees it: the
// machine-local enable flag + resolved local path, plus the proposed default directory LFB offers and
// whether the connected drive is even present on this computer (storage_settings.mdx §4).
export interface StorageBackingLocation {
  enabled: boolean;        // machine-local ON/OFF
  path: string | null;     // this computer's chosen path (null = use proposedDefault)
  proposedDefault: string; // the good default directory LFB proposes (never forced — §4.4)
  available: boolean;      // is this backing target reachable here (Drive/Dropbox linked; repo always true)
  readOnly?: boolean;      // dedicated repo is pre-satisfied + read-only for a repo storage (§4.1)
}

// GET /api/storages/:id/settings — the machine-local per-storage config joined with proposed defaults
// (storage_settings.mdx §5). Identity (name/type/root) is read-only; the rest is configured here.
export interface StorageSettings {
  storageId: string;
  name: string;            // read-only identity (written by discovery — §5)
  type: StorageType;
  root: string;
  pinned: boolean;         // the per-storage IPFS-pinning opt-in (default OFF) — gates mapped-dir byte work
  lfbridge: {
    enabled: boolean;      // keep .lfbridge/ on THIS computer (default ON — §3)
    path: string | null;   // null = default <root>/.lfbridge/ ; else an absolute override
    defaultPath: string;   // <root>/.lfbridge/ — shown as the placeholder default
  };
  backing: {
    dedicatedRepo: StorageBackingLocation;
    googleDrive: StorageBackingLocation;
    dropbox: StorageBackingLocation;
  };
}

// PATCH /api/storages/:id/settings — partial update of the machine-local config (§5). Drive/Dropbox
// paths ALSO write the canonical relative path into storage.yaml clones (handled server-side).
export interface StorageBackingPatch {
  enabled?: boolean;
  path?: string | null;
}
export interface StorageSettingsPatch {
  pinned?: boolean;
  lfbridge?: { enabled?: boolean; path?: string | null };
  backing?: {
    dedicatedRepo?: StorageBackingPatch;
    googleDrive?: StorageBackingPatch;
    dropbox?: StorageBackingPatch;
  };
}

// ── Owned repos (storage_settings.mdx §4c) ───────────────────────────────────
// One row of the Owned-repos list on a company/Personal storage's settings page: a repo whose resolved
// owner maps to this storage, carried with its full RepoOwner so the row can show the (auto-detected) hint
// and set the reassign dropdown's current selection. Reassign reuses POST /api/repos/:repoId/owner.
export interface OwnedRepoRow {
  repoId: string;
  name: string;
  path: string;      // absolute repo path ("" when unknown)
  owner: RepoOwner;  // the resolved owner (auto derivation or manual override — repo_company_mapping.mdx §5)
}

// GET /api/storages/:id/owned-repos — the repos whose owner maps to this storage plus the companies the
// reassign dropdown can target (storage_settings.mdx §4c). Empty for repo/local/community storages.
export interface OwnedReposView {
  storageId: string;
  ownedRepos: OwnedRepoRow[];
  companies: Array<{ id: string; name: string }>; // reassign targets, by friendly display name
}

// ── Generic API envelope for mutations ──────────────────────────────────────
export interface Ok<T = unknown> {
  ok: true;
  data: T;
}
export interface Err {
  ok: false;
  error: string;
  code?: string;
}
export type ApiResult<T = unknown> = Ok<T> | Err;
