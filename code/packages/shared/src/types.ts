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

// ── Auth (mirrors @auth/backend AuthUser, trimmed) ──────────────────────────
export interface CurrentUser {
  authenticated: boolean;
  email: string | null;
  name: string | null;
  roles: string[];
  permissions: string[];
  allowListed: boolean;
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
