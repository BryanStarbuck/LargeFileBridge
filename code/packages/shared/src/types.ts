// @lfb/shared — the cross-package contract (backend REST ↔ frontend).
// These mirror the LOCKED vocabulary in pm/repos.mdx and pm/one_repo.mdx.

// ── Decision model (one_repo.mdx §1, LOCKED) ────────────────────────────────
export type Decision = "sync" | "ignore" | "undecided";

export type TransferStatus =
  | "synced"
  | "pending"
  | "fetching"
  | "pushing"
  | "missing"
  | "error"
  | "na";

// ── Repo rollup status (repos.mdx §1/§4.2, LOCKED) ──────────────────────────
export type RepoStatus =
  | "up_to_date"
  | "syncing"
  | "behind"
  | "needs_review"
  | "error"
  | "never";

export interface RepoCounts {
  synced: number;
  pending: number;
  undecided: number;
  ignored: number;
}

// One row of the Repos table (repos.mdx §1).
export interface RepoRow {
  repoId: string; // stable hash of the absolute path
  bookmarked: boolean; // user favorite (repos.mdx §8) — drives the leading ribbon toggle
  name: string;
  path: string;
  counts: RepoCounts;
  peerCount: number;
  lastSyncAt: string | null;
  status: RepoStatus;
  synced: boolean; // per-repo master toggle (one_repo.mdx §3.2)
}

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
}

// The One-repo detail payload: header/status strip + file rows.
export interface RepoDetail {
  repoId: string;
  name: string;
  path: string;
  remote: string | null;
  synced: boolean;
  status: RepoStatus;
  peerCount: number;
  lastSyncAt: string | null;
  ipfs: IpfsHealth;
  counts: RepoCounts;
  files: FileRow[];
}

export type IpfsHealth = "ok" | "unreachable";

// ── The IPFS page (ipfs.mdx) — the local pinset as ground truth ──────────────
// One row per pinned ROOT CID (indirect blocks rolled under their root — ipfs.mdx §1).
export type IpfsPinType = "recursive" | "direct" | "mfs";

// Tracked state (ipfs.mdx §5.1):
//   synced    — pinned AND in a manifest with a known local path (the normal state)
//   import    — pinned but NOT in any manifest (the actionable import candidate)
//   path-less — tracked (in a manifest) but with no resolvable local path
export type IpfsTracked = "synced" | "import" | "path-less";

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
}

// ── Install / start jobs — server-side, single-flight, re-attachable (ipfs_ui.mdx §7.2) ──
export type IpfsJobKind = "install" | "start" | "stop";
export type IpfsJobPhase =
  | "idle"
  | "detecting"
  | "installing"
  | "initializing"
  | "starting"
  | "stopping"
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
export interface GlobalSettings {
  bigFile: {
    thresholdBytes: number;
    display: ThresholdDisplay;
  };
  scannerRoots: string[];
  ignoreGlobs: string[];
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

// ── Per-repo settings (repo_settings.mdx) ───────────────────────────────────
export interface RepoSettings {
  repoId: string;
  name: string;
  path: string;
  remote: string | null;
  synced: boolean;
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
  sync: {
    pinLocally: boolean;
    fetchMissing: boolean;
    publishManifest: boolean;
  };
  access: {
    shared: boolean;
    participants: string[];
  };
}

// ── Scheduled workers — the transparency contract (scan.mdx §7, storage.mdx §13)
export type WorkerKind = "scan" | "sync";

export interface WorkerState {
  kind: WorkerKind;
  installed: boolean;
  enabled: boolean;
  intervalSeconds: number;
  label: string;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
}

export interface SyncPageData {
  scan: WorkerState;
  sync: WorkerState;
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

// ── Web session activity ping (sessions.mdx) ────────────────────────────────
// Response to POST /api/sessions/activity. `newSession` is true when this ping STARTED a fresh web
// session (a return after the 4h idle window); `autoSyncTriggered` is true when that start was on a
// > 48h-stale machine and a non-blocking syncAll() was fired.
export interface SessionActivityResult {
  newSession: boolean;
  autoSyncTriggered: boolean;
  lastSyncAt: string | null; // "last synchronized" the staleness check read (ISO), or null if never
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
}

// ── File System column browser (directory.mdx) ──────────────────────────────
// One code badge painted on a file/dir row. White letter on a solid color.
// Ordered rightmost-first when they stack: repo(R/r) · sync(S) · compress(C/c) · ipfs(i).
export type FsBadge =
  | "repo_root" // R  dark brown      (dir — its own .git working tree)
  | "repo_descendant" // r  medium brown    (file|dir inside a repo)
  | "repo_ancestor" // r  light brown     (dir that contains a repo below it)
  | "sync" // S  bright pink     (file whose decision === "sync")
  | "compress" // C  bright yellow   (video/image file that looks uncompressed)
  | "compressed" // c  light yellow    (video/image file already compressed)
  | "ipfs"; // i  blue            (IPFS list/share artifact, or dir publishing one)

export type FsEntryKind = "dir" | "file" | "symlink" | "other";

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

// ── Single-entity views + sticky flags (menus.mdx §6.6, files.mdx, directories.mdx) ──
// Two persistent per-entity flags the user sets from the ⋯ / right-click menu or the entity page.
// They apply to a file OR a directory (a directory's flag covers everything under it), survive
// rescans, and NEVER delete or alter local bytes.
export interface FileFlags {
  neverIpfs: boolean; // never add to IPFS / sync this entity (forbids the sync decision)
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

  // Repo / sync context — populated only when the entity is inside a REGISTERED repo.
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

// Per-media codec preferences (compression.mdx §7).
export interface CompressMediaPrefs {
  enabled: boolean;
  quality: CompressQuality;
  prefer: string[]; // ordered target codecs; first allowed+available wins
  deny: string[];   // codecs the user never wants chosen
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

// ── Transcribe (Transcribe.mdx) ─────────────────────────────────────────────
// Which underlying binaries the transcription engine needs are installed (§6 GET /transcribe/tools).
export interface TranscribeTools {
  whisper: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
}
// The result of transcribing one media file (Transcribe.mdx §1). transcriptPath = the .txt written into
// the parallel <storageRoot>/.transcribe/<relpath>.txt hierarchy (§3).
export interface TranscribeResult {
  path: string;               // the media file transcribed
  status: "transcribed" | "skipped" | "no_audio" | "tool_missing" | "failed";
  transcriptPath: string | null;
  words: number | null;       // word count of the transcript body (success only)
  reason: string | null;      // why skipped / no_audio / tool_missing / failed
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
