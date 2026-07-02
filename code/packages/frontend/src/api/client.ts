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
} from "@lfb/shared";
import { http, unwrap } from "./axios.js";

export const api = {
  me: () => unwrap<CurrentUser>(http.get("/auth/me")),
  authConfig: () =>
    unwrap<{ oauthConfigured: boolean; devAuth: boolean }>(http.get("/health/auth-config")),

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

  // File System column browser (directory.mdx).
  fsHome: () => unwrap<{ home: string }>(http.get("/fs/home")),
  fsList: (path?: string, hidden = false) =>
    unwrap<FsListing>(
      http.get("/fs", { params: { ...(path ? { path } : {}), ...(hidden ? { hidden: "1" } : {}) } }),
    ),
};
