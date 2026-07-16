// Typed API calls against @lfb/shared. One function per endpoint (code_plan §10).
import type {
  RepoRow,
  RepoDetail,
  PinNowResult,
  FileRow,
  RepoSettings,
  GlobalSettings,
  PersonalAccount,
  PendingCompanyMapping,
  JobsPageData,
  PeerRow,
  DeviceRow,
  CurrentUser,
  Decision,
  WorkerKind,
  WorkerState,
  WatcherState,
  SizeUnit,
  FsListing,
  FileSystemView,
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
  IpfsAutostartAction,
  IpfsConfigHealth,
  IpfsConfigRepairResult,
  IpfsLiveness,
  ScanJob,
  RescanResult,
  ProgressListResult,
  SessionActivityResult,
  StoragesPageData,
  StorageDetail,
  ArtifactPlacementView,
  StorageIndexResult,
  StorageAnalyzeResult,
  StorageSettings,
  StorageSettingsPatch,
  MappedDirsView,
  MappedDirsPatch,
  CommunitiesPageData,
  CommunityStorageMath,
  CommunitySubscription,
  CommunitySubscriptionPatch,
  CompressTools,
  CompressionSettings,
  CompressCheck,
  CompressResult,
  CompressBatchResult,
  CompressInsideRequest,
  CompressInsidePlan,
  GitIgnoreRequest,
  GitIgnorePlan,
  GitIgnoreResult,
  TranscribeTools,
  TranscribeEngineStatus,
  TranscribeProvisionResult,
  TranscribeResult,
  TranscribeBatchResult,
  TranscriptView,
  PlatformInfo,
  OsOpenResult,
  DescribeKind,
  DescribeProvidersStatus,
  DescribeView,
  DescribeResult,
  OcrView,
  OcrResult,
  OcrBatchResult,
  OcrEnginesStatus,
  DescribeBatchResult,
  DescribePromptView,
  DescribeAiConfig,
  DescribeAiConfigPatch,
  AiCredentialsInfo,
  EnqueuePlan,
  PreviewPlan,
  DecisionPolicyDoc,
  TodoBatchSummary,
  TodoBatchDetail,
  TodoApplyResult,
  TranscribeScanResult,
} from "@lfb/shared";
import { http, unwrap } from "./axios.js";

// The shared per-repo decision policy payload the repo router returns (decisions.mdx §9/§14): the policy
// doc itself + THIS computer's share status (whether decisions travel to teammates — storage/decisions
// .service.ts `shareStatus()`).
export type DecisionShareStatus = "shared" | "local_only_no_remote" | "local_only_consent_off";
export interface DecisionPolicyResult {
  policy: DecisionPolicyDoc;
  shareStatus: DecisionShareStatus;
}

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
  // Stop a batch (processing_batches.mdx §6.2): its QUEUED files become "Not attempted" and can be
  // re-run for free; anything already in flight finishes.
  stopBatch: (batchId: string) => unwrap<{ halted: number }>(http.post(`/progress/batches/${batchId}/stop`)),
  scanStatus: () => unwrap<ScanJob>(http.get("/repos/scan-status")),
  // Progress dock (webapp.mdx §12 source B) — every in-flight server-side job (registry + active scan),
  // so a launchd or other-tab pin/scan still shows a card. Polled by the ProgressProvider.
  progress: () => unwrap<ProgressListResult>(http.get("/progress")),
  // Remove repo (unregister, menus.mdx §5.1) — LFB tracking only; never deletes local files.
  removeRepo: (repoId: string) =>
    unwrap<{ removed: boolean }>(http.delete(`/repos/${repoId}`)),

  repo: (repoId: string) => unwrap<RepoDetail>(http.get(`/repos/${repoId}`)),
  repoFiles: (repoId: string) => unwrap<FileRow[]>(http.get(`/repos/${repoId}/files`)),
  setDecision: (repoId: string, paths: string[], decision: Decision) =>
    unwrap<RepoDetail>(http.patch(`/repos/${repoId}/files`, { paths, decision })),
  // Two-axis decision (decisions.mdx §1): Add-to-IPFS and Add-to-git-ignore, each independent. Both-off
  // is a valid, recorded decision. The backend stamps who/when/SID into the shared .lfbridge/decisions.yaml.
  setFileDecisions: (repoId: string, paths: string[], axes: { ipfs?: boolean; gitignore?: boolean }) =>
    unwrap<RepoDetail>(http.patch(`/repos/${repoId}/files`, { paths, ...axes })),
  pinNow: (repoId: string, paths?: string[]) =>
    unwrap<PinNowResult>(http.post(`/repos/${repoId}/pin`, paths ? { paths } : {})),
  // Pull-them-down (warnings.mdx §10.8.12): pin each checked file's manifest CID on THIS node — which
  // fetches the bytes down over IPFS — and, when `compress` is set, queue a compress pass after arrival.
  // Returns the refreshed repo detail so the "pull them down" banner re-derives and leaves the page.
  pull: (repoId: string, paths: string[], opts?: { compress?: boolean }) =>
    unwrap<RepoDetail>(http.post(`/repos/${repoId}/pull`, { paths, ...(opts ?? {}) })),
  // Shared decision policy (decisions.mdx §9/§14): read / patch the per-repo default-decision + attribution
  // policy. Both return { policy, shareStatus } (the doc + whether this computer shares decisions).
  decisionPolicy: (repoId: string) =>
    unwrap<DecisionPolicyResult>(http.get(`/repos/${repoId}/decision-policy`)),
  setDecisionPolicy: (repoId: string, patch: Partial<DecisionPolicyDoc>) =>
    unwrap<DecisionPolicyResult>(http.patch(`/repos/${repoId}/decision-policy`, patch)),

  repoSettings: (repoId: string) => unwrap<RepoSettings>(http.get(`/repos/${repoId}/settings`)),
  patchRepoSettings: (repoId: string, patch: Partial<Record<string, unknown>>) =>
    unwrap<RepoSettings>(http.patch(`/repos/${repoId}/settings`, patch)),

  settings: () => unwrap<GlobalSettings>(http.get("/settings")),
  patchSettings: (patch: {
    bigFile?: { value: number; unit: SizeUnit };
    scannerRoots?: string[];
    personalAccounts?: PersonalAccount[];
    ipfs?: Record<string, unknown>;
    performance?: { maxCoreFraction: number };
  }) => unwrap<GlobalSettings>(http.patch("/settings", patch)),
  // Pending cross-member company-ownership mappings awaiting this member's review (repo_owner_propagation.mdx §4).
  companyMappingsPending: () => unwrap<PendingCompanyMapping[]>(http.get("/company-mappings/pending")),
  allowList: () => unwrap<string[]>(http.get("/settings/allow-list")),
  setAllowList: (emails: string[]) =>
    unwrap<string[]>(http.patch("/settings/allow-list", { emails })),

  // Web-session activity ping (sessions.mdx). Fired on app open + each route render; the server rolls
  // it into the open session and, on a stale return (>48h), kicks a non-blocking pin.
  recordActivity: () => unwrap<SessionActivityResult>(http.post("/sessions/activity")),

  jobsPage: () => unwrap<JobsPageData>(http.get("/jobs")),
  controlWorker: (worker: WorkerKind, action: "install" | "uninstall" | "enable" | "disable") =>
    unwrap<WorkerState>(http.post(`/jobs/${worker}/${action}`)),
  // The live filesystem watcher (scan.mdx §2.2) — enable/disable only (no install step).
  controlWatcher: (action: "enable" | "disable") =>
    unwrap<WatcherState>(http.post(`/jobs/watcher/${action}`)),

  peers: () => unwrap<PeerRow[]>(http.get("/peers")),
  // The Devices / Peers table (devices.mdx §6) — self + peers.yaml + registry, unioned & disambiguated.
  devices: () => unwrap<DeviceRow[]>(http.get("/devices")),
  // One device by id — the "View one device" page (devices.mdx §6).
  device: (id: string) => unwrap<DeviceRow>(http.get(`/devices/${encodeURIComponent(id)}`)),
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
  // Cheap app-wide liveness for the nudge banner (ipfs_ui.mdx §10/§17) — never walks the pinset.
  ipfsLiveness: () => unwrap<IpfsLiveness>(http.get("/ipfs/liveness")),
  ipfsInstall: () => unwrap<IpfsInstallJob>(http.post("/ipfs/install")),
  ipfsInstallStatus: () => unwrap<IpfsInstallJob>(http.get("/ipfs/install/status")),
  // The on/off toggle. `autostart` (start only) ALSO sets IPFS to come back after a reboot (§12).
  ipfsDaemon: (body: { action: IpfsDaemonAction; autostart?: boolean }) =>
    unwrap<IpfsDaemonResult>(http.post("/ipfs/daemon", body)),
  // Set up or remove reboot auto-start directly; returns the fresh node status (ipfs_ui.mdx §13).
  ipfsAutostart: (action: IpfsAutostartAction) =>
    unwrap<IpfsNodeStatus>(http.post("/ipfs/autostart", { action })),
  // Config health & guided self-repair (ipfs_ui.mdx §14) — read the node config, then fix it on an
  // explicit click (confirm-then-apply; a timestamped backup is written first).
  ipfsConfigHealth: () => unwrap<IpfsConfigHealth>(http.get("/ipfs/config-health")),
  ipfsConfigRepair: (issueIds?: string[]) =>
    unwrap<IpfsConfigRepairResult>(http.post("/ipfs/config-repair", { issueIds })),
  // Upgrade the ipfs binary via the package manager (ipfs_ui.mdx §15) — runs as a watchable job.
  ipfsUpgrade: () => unwrap<IpfsInstallJob>(http.post("/ipfs/upgrade")),

  // File System column browser (directory.mdx).
  fsHome: () => unwrap<{ home: string }>(http.get("/fs/home")),
  fsList: (path?: string, hidden = false) =>
    unwrap<FsListing>(
      http.get("/fs", { params: { ...(path ? { path } : {}), ...(hidden ? { hidden: "1" } : {}) } }),
    ),
  // Persisted File System view state (directories.mdx §1.3) — the open column chain + selection +
  // header filters, so leaving and returning restores where the user left off. GET is pruned to what
  // still exists on this machine (stale paths dropped); PUT is debounced by the page on every change.
  fsViewState: () => unwrap<FileSystemView | null>(http.get("/fs/view-state")),
  saveFsViewState: (view: {
    columns: string[];
    selection: string[];
    filters?: Partial<{ only_large: boolean; videos: boolean; images: boolean; audio: boolean }>;
  }) => unwrap<FileSystemView | null>(http.put("/fs/view-state", view)),
  // OS hand-off (os_open.mdx) — the host platform label + whether "Open on {label}" is possible here,
  // and the localhost-only action that opens a local file/folder in the desktop OS default handler.
  platform: () => unwrap<PlatformInfo>(http.get("/fs/platform")),
  osOpen: (path: string) => unwrap<OsOpenResult>(http.post("/fs/os-open", { path })),
  // Full paths — the flat, recursive large-file table (full_paths.mdx).
  fsFlat: (path?: string, hidden = false) =>
    unwrap<FlatFileListing>(
      http.get("/fs/flat", {
        params: { ...(path ? { path } : {}), ...(hidden ? { hidden: "1" } : {}) },
      }),
    ),

  // Single-entity views + the ⋯ / right-click menus (files.mdx, directories.mdx, menus.mdx §5).
  entity: (path: string) => unwrap<EntityView>(http.get("/entity", { params: { path } })),
  // The ⋯ / right-click MENU payload: rollup:0 skips the expensive directory walk the menu never reads
  // (menus.mdx §5 uses only kind/repo/decision/flags/compress state), so the menu opens instantly on
  // big/cloud-mounted directories. A 10 s per-request timeout guarantees the menu can never sit on
  // "Loading…" forever if the backend stalls — it surfaces an error the menu can show + retry.
  entityMenu: (path: string) =>
    unwrap<EntityView>(http.get("/entity", { params: { path, rollup: 0 }, timeout: 10_000 })),
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
  compressFile: (path: string, opts?: { videoCodec?: "h264" | "hevc" | "av1" }) =>
    unwrap<CompressResult>(http.post("/compress/file", { path, ...(opts ?? {}) })),
  compressBatch: (paths: string[]) => unwrap<CompressBatchResult>(http.post("/compress/batch", { paths })),
  // The "Compress videos & images inside" dialog (compress_inside.mdx §5) — plans + background-queues a
  // directory's media and returns the plan immediately; the batch drains in the background.
  compressInside: (req: CompressInsideRequest) =>
    unwrap<CompressInsidePlan>(http.post("/compress/inside", req)),
  // Git Ignore (git_ignore.mdx §6). plan → the exact anchored .gitignore lines the dialog previews;
  // apply → writes them into each owning repo's .gitignore (synchronous — a few lines of text). The
  // dialog invalidates the fs/entity queries on apply so the new "I" git-ignored badge appears.
  gitIgnorePlan: (req: GitIgnoreRequest) =>
    unwrap<GitIgnorePlan>(http.post("/git/ignore/plan", req)),
  gitIgnoreApply: (req: GitIgnoreRequest) =>
    unwrap<GitIgnoreResult>(http.post("/git/ignore/apply", req)),
  // Transcribe (Transcribe.mdx). Tool status, read an existing transcript, and run transcription over one
  // file / a selected set / a directory-or-repo tree / a whole storage. Writes a .transcription sidecar beside the media.
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
  // "Create Transcriptions" page action (page_actions.mdx §5): plan + background-queue the checked `paths`
  // or the recursive `root`; returns the plan immediately (willProcess = the toast count).
  transcribeEnqueue: (body: { paths?: string[]; root?: string; overwrite?: boolean }) =>
    unwrap<EnqueuePlan>(http.post("/transcribe/enqueue", body)),
  // Preview-only (dialogs.mdx §5.2): the eligible candidate list under a scope, nothing queued — the batch popup's data source.
  transcribePlan: (body: { paths?: string[]; root?: string; overwrite?: boolean }) =>
    unwrap<PreviewPlan>(http.post("/transcribe/plan", body)),
  // Transcription ENGINE + heavyweight-model provisioning (transcribe_engine.mdx §3/§6).
  transcribeEngine: () => unwrap<TranscribeEngineStatus>(http.get("/transcribe/engine")),
  transcribeProvision: () => unwrap<TranscribeProvisionResult>(http.post("/transcribe/engine/provision", { approve: true })),
  transcribeRepair: () => unwrap<TranscribeProvisionResult>(http.post("/transcribe/engine/repair", {})),
  transcribeRemoveModel: () => unwrap<{ removed: boolean; freedBytes: number }>(http.post("/transcribe/engine/remove", {})),
  transcribeConsent: (decision: "approved" | "declined" | "use_fallback") =>
    unwrap<TranscribeEngineStatus>(http.post("/transcribe/engine/consent", { decision })),
  // Set the preferred engine (transcribe_engine.mdx §6): auto (best available) or pin speech/mac/qwen.
  transcribeSetEngine: (engine: "auto" | "speech" | "qwen" | "mac") =>
    unwrap<TranscribeEngineStatus>(http.post("/transcribe/engine/choice", { engine })),
  // AI description (ai_description.mdx). Provider status, read an existing description, generate one (the
  // external vision call), and read/customize/save/reset the per-kind prompt files.
  describeProviders: () => unwrap<DescribeProvidersStatus>(http.get("/describe/providers")),
  // Where to put a Gemini key + in what format — powers the "AI credentials" instructions page and the
  // credentials-missing popup (ai_credentials.mdx). Never returns a raw key value.
  aiCredentials: () => unwrap<AiCredentialsInfo>(http.get("/describe/credentials")),
  description: (path: string) => unwrap<DescribeView | null>(http.get("/describe/file", { params: { path } })),
  describeFile: (path: string, opts?: { overwrite?: boolean; provider?: "auto" | "gemini" | "grok" | "openai" }) =>
    unwrap<DescribeResult>(http.post("/describe/file", { path, ...(opts ?? {}) })),
  describeBatch: (paths: string[], opts?: { overwrite?: boolean; provider?: "auto" | "gemini" | "grok" | "openai" }) =>
    unwrap<DescribeBatchResult>(http.post("/describe/batch", { paths, ...(opts ?? {}) })),
  describeTree: (path: string, opts?: { overwrite?: boolean; provider?: "auto" | "gemini" | "grok" | "openai" }) =>
    unwrap<DescribeBatchResult>(http.post("/describe/tree", { path, ...(opts ?? {}) })),
  // "Create AI descriptions" page action (page_actions.mdx §5): plan + background-queue; returns the plan.
  describeEnqueue: (body: { paths?: string[]; root?: string; overwrite?: boolean; provider?: "auto" | "gemini" | "grok" | "openai" }) =>
    unwrap<EnqueuePlan>(http.post("/describe/enqueue", body)),
  // Preview-only (dialogs.mdx §5.2): the eligible candidate list under a scope, nothing queued.
  describePlan: (body: { paths?: string[]; root?: string; overwrite?: boolean }) =>
    unwrap<PreviewPlan>(http.post("/describe/plan", body)),
  // Close a provider's open circuit after the user has fixed the account (to_fix.mdx §2.4 — "Close on user
  // Resume or a successful probe"). The ONE thing the halted banner's Resume does; the halted files are then
  // re-queued by re-running the action, since a halt drains the queue rather than parking it.
  describeResume: (provider: "gemini" | "grok" | "openai") =>
    unwrap<{ resumed: boolean }>(http.post("/describe/resume", { provider })),
  describePrompt: (kind: DescribeKind) => unwrap<DescribePromptView>(http.get("/describe/prompt", { params: { kind } })),
  customizeDescribePrompt: (kind: DescribeKind) =>
    unwrap<DescribePromptView>(http.post("/describe/prompt/customize", { kind })),
  saveDescribePrompt: (kind: DescribeKind, text: string) =>
    unwrap<DescribePromptView>(http.put("/describe/prompt", { kind, text })),
  resetDescribePrompt: (kind: DescribeKind) =>
    unwrap<DescribePromptView>(http.delete("/describe/prompt", { params: { kind } })),
  // AI provider config for the global Settings page — default provider + per-provider API key + model.
  // Reads return the key SOURCE (config/env), never the raw key; a "" apiKey clears the config key.
  aiConfig: () => unwrap<DescribeAiConfig>(http.get("/describe/config")),
  setAiConfig: (patch: DescribeAiConfigPatch) => unwrap<DescribeAiConfig>(http.patch("/describe/config", patch)),

  // ── OCR — read the text out of image/video pixels (ocr.mdx §18) ─────────────────────────────────────
  // The third analysis transaction. Note what is ABSENT next to describe*: no providers, no credentials, no
  // config, no resume. OCR is 100% LOCAL (ocr.mdx §4) — there is no account to configure or to be dead.
  ocrEngines: () => unwrap<OcrEnginesStatus>(http.get("/ocr/engines")),
  // `text: ""` on a real artifact is a SUCCESS, not a null (ocr.mdx §2.3) — most images have no text.
  ocr: (path: string) => unwrap<OcrView | null>(http.get("/ocr/file", { params: { path } })),
  ocrFile: (path: string, opts?: { overwrite?: boolean; engine?: "auto" | "vision" | "tesseract" }) =>
    unwrap<OcrResult>(http.post("/ocr/file", { path, ...(opts ?? {}) })),
  ocrBatch: (paths: string[], opts?: { overwrite?: boolean; engine?: "auto" | "vision" | "tesseract" }) =>
    unwrap<OcrBatchResult>(http.post("/ocr/batch", { paths, ...(opts ?? {}) })),
  ocrTree: (path: string, opts?: { overwrite?: boolean; engine?: "auto" | "vision" | "tesseract" }) =>
    unwrap<OcrBatchResult>(http.post("/ocr/tree", { path, ...(opts ?? {}) })),
  // "Create OCR text" page action (ocr.mdx §8.5): plan + background-queue; returns the plan immediately.
  ocrEnqueue: (body: { paths?: string[]; root?: string; overwrite?: boolean; engine?: "auto" | "vision" | "tesseract" }) =>
    unwrap<EnqueuePlan>(http.post("/ocr/enqueue", body)),
  // Preview-only (dialogs.mdx §5.2): the eligible candidates under a scope, nothing queued. Video rows carry
  // `frames` so the popup can show why one row is expensive before the user commits (ocr.mdx §9.2).
  ocrPlan: (body: { paths?: string[]; root?: string; overwrite?: boolean }) =>
    unwrap<PreviewPlan>(http.post("/ocr/plan", body)),
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
  // First-time setup wizard commit (Transcribe.mdx §3.5): create the ONE Personal storage at its canonical
  // root; `dedicatedRepo` makes it a git repo whose artifacts are tracked+pinned (not git-ignored).
  createPersonalStorage: (dedicatedRepo: boolean) =>
    unwrap<StorageDetail>(http.post("/storages/personal/create", { dedicatedRepo })),
  // Where a media file's derived artifacts (transcript / AI description) will land, and whether the
  // first-time setup wizard must run first (Transcribe.mdx §3.4–§3.5).
  placement: (path: string) => unwrap<ArtifactPlacementView>(http.get("/storages/placement", { params: { path } })),
  indexStorage: (id: string) => unwrap<StorageIndexResult>(http.post(`/storages/${id}/index`)),
  analyzeStorageFile: (id: string, path: string) =>
    unwrap<StorageAnalyzeResult>(http.post(`/storages/${id}/analyze`, { path })),
  // Per-storage settings (storage_settings.mdx §5): keep .lfbridge/ + where, and the three backing
  // locations (dedicated repo / Google Drive / Dropbox) each ON/OFF with its own path.
  storageSettings: (id: string) => unwrap<StorageSettings>(http.get(`/storages/${id}/settings`)),
  patchStorageSettings: (id: string, patch: StorageSettingsPatch) =>
    unwrap<StorageSettings>(http.patch(`/storages/${id}/settings`, patch)),
  // Mapped source directories (storage_settings.mdx §4a): the shared list of hierarchies a company/personal
  // storage covers, joined with THIS computer's per-row graft path.
  storageMappedDirs: (id: string) => unwrap<MappedDirsView>(http.get(`/storages/${id}/mapped-dirs`)),
  patchStorageMappedDirs: (id: string, patch: MappedDirsPatch) =>
    unwrap<MappedDirsView>(http.patch(`/storages/${id}/mapped-dirs`, patch)),

  // Communities (communities.mdx). The page payload (storage-math header + rows), the machine-wide
  // budget, and one community's subscription (intent + Block/Recommended/Full backup mode + bookmark).
  communities: () => unwrap<CommunitiesPageData>(http.get("/communities")),
  setCommunityBudget: (bytes: number | null) =>
    unwrap<CommunityStorageMath>(http.put("/communities/budget", { bytes })),
  patchCommunity: (id: string, patch: CommunitySubscriptionPatch) =>
    unwrap<CommunitySubscription>(http.patch(`/communities/${id}`, patch)),

  // To Do (to_do.mdx). The per-storage TO DO Batches with work (slug summaries), one batch's items (the
  // popup), dismiss (red trash — never deletes files), apply the checked recommendations, and the
  // on-demand "Show what could be transcribed" scan.
  todoBatches: () => unwrap<TodoBatchSummary[]>(http.get("/todo/batches")),
  todoBatch: (id: string) => unwrap<TodoBatchDetail>(http.get(`/todo/batches/${encodeURIComponent(id)}`)),
  dismissTodoBatch: (id: string) =>
    unwrap<{ dismissed: boolean }>(http.delete(`/todo/batches/${encodeURIComponent(id)}`)),
  applyTodoBatch: (
    id: string,
    paths?: string[],
    perRow?: Record<string, { ipfs?: boolean; ignore?: boolean; compress?: boolean }>,
  ) =>
    unwrap<TodoApplyResult>(
      http.post(`/todo/batches/${encodeURIComponent(id)}/apply`, {
        ...(paths ? { paths } : {}),
        ...(perRow ? { perRow } : {}),
      }),
    ),
  // No `scope` scans every storage; a `scope` (storage id or repo id) scans just that one storage
  // (transcribe_calc_engine.mdx §1 — the storage-detail "Show what could be transcribed" action).
  transcribeScan: (scope?: string) =>
    unwrap<TranscribeScanResult>(
      http.post(`/todo/transcribe-scan${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, {}),
    ),

  // Media viewer (media_viewer.mdx §2). grant → a short-lived same-origin URL the <img>/<video>
  // element loads (Range-capable); probe → best-effort container/codec/dimensions.
  mediaGrant: (path: string) => unwrap<MediaGrant>(http.get("/media/grant", { params: { path } })),
  mediaProbe: (path: string) => unwrap<MediaProbe>(http.get("/media/probe", { params: { path } })),
};
