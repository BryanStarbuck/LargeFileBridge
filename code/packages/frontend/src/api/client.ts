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
  IpfsPageData,
  IpfsImportResult,
} from "@lfb/shared";
import { http, unwrap } from "./axios.js";

export const api = {
  me: () => unwrap<CurrentUser>(http.get("/auth/me")),
  authConfig: () => unwrap<AuthConfig>(http.get("/health/auth-config")),

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
  rescan: () => unwrap<{ rescanned: boolean }>(http.post("/repos/rescan")),

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

  syncPage: () => unwrap<SyncPageData>(http.get("/sync")),
  controlWorker: (worker: WorkerKind, action: "install" | "uninstall" | "enable" | "disable") =>
    unwrap<WorkerState>(http.post(`/sync/${worker}/${action}`)),

  peers: () => unwrap<PeerRow[]>(http.get("/peers")),

  // IPFS page (ipfs.mdx) — the local pinset as ground truth + import of untracked pins.
  ipfs: () => unwrap<IpfsPageData>(http.get("/ipfs")),
  ipfsRescan: () => unwrap<IpfsPageData>(http.post("/ipfs/rescan")),
  ipfsImport: (body: { cids?: string[]; all?: boolean }) =>
    unwrap<IpfsImportResult>(http.post("/ipfs/import", body)),
  ipfsEnforce: () => unwrap<IpfsPageData>(http.post("/ipfs/enforce")),

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

  // Media viewer (media_viewer.mdx §2). grant → a short-lived same-origin URL the <img>/<video>
  // element loads (Range-capable); probe → best-effort container/codec/dimensions.
  mediaGrant: (path: string) => unwrap<MediaGrant>(http.get("/media/grant", { params: { path } })),
  mediaProbe: (path: string) => unwrap<MediaProbe>(http.get("/media/probe", { params: { path } })),
};
