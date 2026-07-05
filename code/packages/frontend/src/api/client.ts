// Typed API calls against @lfb/shared. One function per endpoint (code_plan §10).
import type {
  RepoRow,
  RepoDetail,
  FileRow,
  RepoSettings,
  GlobalSettings,
  SyncPageData,
  PeerRow,
  CurrentUser,
  Decision,
  WorkerKind,
  WorkerState,
  SizeUnit,
  FsListing,
  FlatFileListing,
  EntityView,
  AuthConfig,
  SecurityConfigPublic,
  SecurityAccess,
  SecuritySetupInput,
  SecuritySetupResult,
  MediaProbe,
  MediaGrant,
  IpfsHealth,
  IpfsPageData,
  IpfsImportResult,
  IpfsPinToggle,
  IpfsNodeStatus,
  IpfsInstallJob,
  IpfsDaemonResult,
  IpfsDaemonAction,
  ScanJob,
  RescanResult,
  SessionActivityResult,
  StoragesPageData,
  StorageDetail,
  StorageIndexResult,
  StorageAnalyzeResult,
  StorageSettings,
  StorageSettingsPatch,
  CompressTools,
  CompressionSettings,
  CompressCheck,
  CompressResult,
  CompressBatchResult,
  TranscribeTools,
  TranscribeResult,
  TranscribeBatchResult,
  TranscriptView,
} from "@lfb/shared";
import { http, unwrap } from "./axios.js";

export const api = {
  me: () => unwrap<CurrentUser>(http.get("/auth/me")),
  authConfig: () => unwrap<AuthConfig>(http.get("/health/auth-config")),
  // Cheap liveness — { status, ipfs }. Drives the media viewer's node-unreachable IPFS-button
  // disable (media_viewer.mdx §5) without walking the pinset like api.ipfs() does.
  health: () => unwrap<{ status: string; ipfs: IpfsHealth }>(http.get("/health")),

  // Security allow-list (security.mdx §7). config is public; setup is one-time + loopback-guarded;
  // security/setSecurity are the admin-only return-visit editor.
  securityConfig: () => unwrap<SecurityConfigPublic>(http.get("/security/config")),
  securitySetup: (input: SecuritySetupInput) =>
    unwrap<SecuritySetupResult>(http.post("/security/setup", input)),
  security: () => unwrap<SecurityAccess>(http.get("/settings/security")),
  setSecurity: (input: SecuritySetupInput) =>
    unwrap<{ access: SecurityAccess; restartRecommended: boolean }>(
      http.patch("/settings/security", input),
    ),

  repos: () => unwrap<RepoRow[]>(http.get("/repos")),
  addRepo: (path: string) => unwrap<{ repoId: string }>(http.post("/repos", { path })),
  toggleBookmark: (repoId: string, bookmarked: boolean) =>
    unwrap<RepoRow>(http.post(`/repos/${repoId}/bookmark`, { bookmarked })),
  rescan: () => unwrap<RescanResult>(http.post("/repos/rescan")),
  scanStatus: () => unwrap<ScanJob>(http.get("/repos/scan-status")),
  // Remove repo (unregister, menus.mdx §5.1) — LFB tracking only; never deletes local files.
  removeRepo: (repoId: string) =>
    unwrap<{ removed: boolean }>(http.delete(`/repos/${repoId}`)),

  repo: (repoId: string) => unwrap<RepoDetail>(http.get(`/repos/${repoId}`)),
  repoFiles: (repoId: string) => unwrap<FileRow[]>(http.get(`/repos/${repoId}/files`)),
  setDecision: (repoId: string, paths: string[], decision: Decision) =>
    unwrap<RepoDetail>(http.patch(`/repos/${repoId}/files`, { paths, decision })),
  syncNow: (repoId: string, paths?: string[]) =>
    unwrap<RepoDetail>(http.post(`/repos/${repoId}/sync`, paths ? { paths } : {})),

  repoSettings: (repoId: string) => unwrap<RepoSettings>(http.get(`/repos/${repoId}/settings`)),
  patchRepoSettings: (repoId: string, patch: Partial<Record<string, unknown>>) =>
    unwrap<RepoSettings>(http.patch(`/repos/${repoId}/settings`, patch)),

  settings: () => unwrap<GlobalSettings>(http.get("/settings")),
  patchSettings: (patch: {
    bigFile?: { value: number; unit: SizeUnit };
    scannerRoots?: string[];
    ipfs?: Record<string, unknown>;
  }) => unwrap<GlobalSettings>(http.patch("/settings", patch)),
  allowList: () => unwrap<string[]>(http.get("/settings/allow-list")),
  setAllowList: (emails: string[]) =>
    unwrap<string[]>(http.patch("/settings/allow-list", { emails })),

  // Web-session activity ping (sessions.mdx). Fired on app open + each route render; the server rolls
  // it into the open session and, on a stale return (>48h), kicks a non-blocking sync.
  recordActivity: () => unwrap<SessionActivityResult>(http.post("/sessions/activity")),

  syncPage: () => unwrap<SyncPageData>(http.get("/sync")),
  controlWorker: (worker: WorkerKind, action: "install" | "uninstall" | "enable" | "disable") =>
    unwrap<WorkerState>(http.post(`/sync/${worker}/${action}`)),

  peers: () => unwrap<PeerRow[]>(http.get("/peers")),
  // Remove peer (menus.mdx §5.4) — forgets the computer from peers.yaml; touches no remote content.
  removePeer: (id: string) => unwrap<{ removed: boolean }>(http.delete(`/peers/${id}`)),

  // IPFS page (ipfs.mdx) — the local pinset as ground truth + import of untracked pins.
  ipfs: () => unwrap<IpfsPageData>(http.get("/ipfs")),
  ipfsRescan: () => unwrap<IpfsPageData>(http.post("/ipfs/rescan")),
  ipfsImport: (body: { cids?: string[]; all?: boolean }) =>
    unwrap<IpfsImportResult>(http.post("/ipfs/import", body)),
  // Toggle a single CID's pin (ipfs.mdx §3). Returns the VERIFIED state read back from the node.
  ipfsPin: (body: { cid: string; pinned: boolean }) =>
    unwrap<IpfsPinToggle>(http.post("/ipfs/pin", body)),
  ipfsEnforce: () => unwrap<IpfsPageData>(http.post("/ipfs/enforce")),

  // IPFS dashboard (ipfs_ui.mdx) — node status, install, on/off toggle, install/start progress.
  ipfsNode: () => unwrap<IpfsNodeStatus>(http.get("/ipfs/node")),
  ipfsInstall: () => unwrap<IpfsInstallJob>(http.post("/ipfs/install")),
  ipfsInstallStatus: () => unwrap<IpfsInstallJob>(http.get("/ipfs/install/status")),
  ipfsDaemon: (action: IpfsDaemonAction) =>
    unwrap<IpfsDaemonResult>(http.post("/ipfs/daemon", { action })),

  // File System column browser (directory.mdx).
  fsHome: () => unwrap<{ home: string }>(http.get("/fs/home")),
  fsList: (path?: string, hidden = false) =>
    unwrap<FsListing>(
      http.get("/fs", { params: { ...(path ? { path } : {}), ...(hidden ? { hidden: "1" } : {}) } }),
    ),
  // Full paths — the flat, recursive large-file table (full_paths.mdx).
  fsFlat: (path?: string, hidden = false) =>
    unwrap<FlatFileListing>(
      http.get("/fs/flat", {
        params: { ...(path ? { path } : {}), ...(hidden ? { hidden: "1" } : {}) },
      }),
    ),

  // Single-entity views + the ⋯ / right-click menus (files.mdx, directories.mdx, menus.mdx §5).
  entity: (path: string) => unwrap<EntityView>(http.get("/entity", { params: { path } })),
  setEntityFlags: (path: string, flags: { neverIpfs?: boolean; noCompress?: boolean }) =>
    unwrap<EntityView>(http.patch("/entity/flags", { path, ...flags })),
  setEntityDecision: (path: string, decision: Decision) =>
    unwrap<EntityView>(http.post("/entity/decision", { path, decision })),
  compressEntity: (path: string) =>
    unwrap<{ queued: boolean }>(http.post("/entity/compress", { path })),
  // Compression engine (compression.mdx). Tool status, codec settings, the dry-run check, and the real
  // compress (one / many). The check drives the pre-compress alpha warning.
  compressTools: () => unwrap<CompressTools>(http.get("/compress/tools")),
  compressSettings: () => unwrap<CompressionSettings>(http.get("/compress/settings")),
  setCompressSettings: (patch: Partial<CompressionSettings>) =>
    unwrap<CompressionSettings>(http.patch("/compress/settings", patch)),
  compressCheck: (path: string) => unwrap<CompressCheck>(http.get("/compress/check", { params: { path } })),
  compressFile: (path: string) => unwrap<CompressResult>(http.post("/compress/file", { path })),
  compressBatch: (paths: string[]) => unwrap<CompressBatchResult>(http.post("/compress/batch", { paths })),
  // Transcribe (Transcribe.mdx). Tool status, read an existing transcript, and run transcription over one
  // file / a selected set / a directory-or-repo tree / a whole storage. Writes to <storageRoot>/.transcribe/.
  transcribeTools: () => unwrap<TranscribeTools>(http.get("/transcribe/tools")),
  transcript: (path: string) => unwrap<TranscriptView | null>(http.get("/transcribe/file", { params: { path } })),
  transcribeFile: (path: string, overwrite = false) =>
    unwrap<TranscribeResult>(http.post("/transcribe/file", { path, overwrite })),
  transcribeBatch: (paths: string[], overwrite = false) =>
    unwrap<TranscribeBatchResult>(http.post("/transcribe/batch", { paths, overwrite })),
  transcribeTree: (path: string, overwrite = false) =>
    unwrap<TranscribeBatchResult>(http.post("/transcribe/tree", { path, overwrite })),
  transcribeStorage: (id: string, overwrite = false) =>
    unwrap<TranscribeBatchResult>(http.post(`/transcribe/storage/${id}`, { overwrite })),
  // Move (guarded rename) + Delete (recoverable move-to-trash) a single file — media_viewer.mdx §4.4.
  moveEntity: (path: string, dest: string) =>
    unwrap<{ moved: boolean; path: string }>(http.post("/entity/move", { path, dest })),
  deleteEntity: (path: string) =>
    unwrap<{ trashed: boolean; trashPath: string }>(http.post("/entity/delete", { path })),

  // Storages (storages.mdx). The Storages tab payload, one storage's detail, and the per-storage
  // init / index / analyze actions.
  storages: () => unwrap<StoragesPageData>(http.get("/storages")),
  storageDetail: (id: string) => unwrap<StorageDetail>(http.get(`/storages/${id}`)),
  initStorage: (id: string) => unwrap<StorageDetail>(http.post(`/storages/${id}/init`)),
  indexStorage: (id: string) => unwrap<StorageIndexResult>(http.post(`/storages/${id}/index`)),
  analyzeStorageFile: (id: string, path: string) =>
    unwrap<StorageAnalyzeResult>(http.post(`/storages/${id}/analyze`, { path })),
  // Per-storage settings (storage_settings.mdx §5): keep .lfbridge/ + where, and the three backing
  // locations (dedicated repo / Google Drive / Dropbox) each ON/OFF with its own path.
  storageSettings: (id: string) => unwrap<StorageSettings>(http.get(`/storages/${id}/settings`)),
  patchStorageSettings: (id: string, patch: StorageSettingsPatch) =>
    unwrap<StorageSettings>(http.patch(`/storages/${id}/settings`, patch)),

  // Media viewer (media_viewer.mdx §2). grant → a short-lived same-origin URL the <img>/<video>
  // element loads (Range-capable); probe → best-effort container/codec/dimensions.
  mediaGrant: (path: string) => unwrap<MediaGrant>(http.get("/media/grant", { params: { path } })),
  mediaProbe: (path: string) => unwrap<MediaProbe>(http.get("/media/probe", { params: { path } })),
};
