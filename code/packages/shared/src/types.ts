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
export type MediaKind = "image" | "video";

// Best-effort, LOCAL-ONLY, NO-SHELL probe of a media file (media_viewer.mdx §2). Every field is
// nullable: the sniff reads a bounded header/tail and reports only what it can determine. The viewer
// never blocks on this — the bytes stream from the signed grant URL regardless.
export interface MediaProbe {
  kind: "image" | "video" | "other"; // from the extension family
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
