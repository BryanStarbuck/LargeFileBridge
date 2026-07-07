// Zod schemas for the on-disk YAML the store reads/writes (storage.mdx §14 inventory).
// Kept in @lfb/shared so backend validation and any frontend type-narrowing agree.
import { z } from "zod";

const iso = z.string();

// ── hardware fingerprint (devices.mdx §7) ───────────────────────────────────
// The facts that identify a PHYSICAL computer, collected ENTIRELY LOCALLY (never over the network).
// Lives on `config.yaml → computer.hardware` (this machine) and is copied into each device file
// (`devices/<device>.yaml → device.hardware`) so OTHER computers can identify & disambiguate this one.
// Everything is optional/defaulted — off macOS (or when a probe fails) fields stay blank/null and the
// UI degrades gracefully.
export const DeviceHardwareSchema = z
  .object({
    platform: z.string().default(""), // os.platform(): darwin | linux | win32
    kind: z.string().default(""), // laptop | desktop | server (derived, devices.mdx §7)
    hostname: z.string().default(""), // os.hostname()
    username: z.string().default(""), // os.userInfo().username — the logged-in OS user
    home_dir: z.string().default(""), // os.homedir() — the ~ dir; which user this machine belongs to
    model_identifier: z.string().default(""), // `sysctl -n hw.model` → Mac14,7
    model_name: z.string().default(""), // system_profiler SPHardwareDataType → Model Name
    marketing_name: z.string().default(""), // resolved from the model table, e.g. "MacBook Pro (14-inch, 2023)"
    year: z.number().nullable().default(null), // model year (from the model table)
    chip: z.string().default(""), // system_profiler → Chip / Processor Name
    arch: z.string().default(""), // os.arch()
    cpu_cores: z.number().nullable().default(null), // os.cpus().length
    ram_gb: z.number().nullable().default(null), // round(os.totalmem() / 1e9)
    disk_total_gb: z.number().nullable().default(null), // fs.statfsSync('/') total, in GB
    screen_inches: z.number().nullable().default(null), // built-in display size (model table)
    screen_count: z.number().nullable().default(null), // SPDisplaysDataType resolution count
  })
  .default({});
// On-disk (snake_case) shape. The camelCase UI mirror is `DeviceHardware` in types.ts.
export type DeviceHardwareDoc = z.infer<typeof DeviceHardwareSchema>;

// ── app-level config.yaml (storage.mdx §3 + settings.mdx §1.3) ──────────────
export const AppConfigSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  server: z
    .object({
      frontend_port: z.number().default(2222), // web app (browser-facing) default; smart-resolved on boot
      backend_port: z.number().default(8787),
      mode: z.enum(["local", "server"]).default("local"),
      cors_origins: z.array(z.string()).default([]),
    })
    .default({}),
  computer: z
    .object({
      id: z.string().optional(),
      label: z.string().default("this-computer"),
      ipfs_peer_id: z.string().nullable().default(null),
      hardware: DeviceHardwareSchema, // this machine's fingerprint (devices.mdx §7) — seeded on first run
    })
    .default({}),
  ipfs: z
    .object({
      api_addr: z.string().default("/ip4/127.0.0.1/tcp/5001"),
      gateway_addr: z.string().default("/ip4/127.0.0.1/tcp/8081"),
      pin_mode: z.enum(["recursive", "direct"]).default("recursive"),
      auto_start_daemon: z.boolean().default(false),
      reprovide: z.boolean().default(true),
      reprovide_strategy: z.enum(["pinned", "roots", "all"]).default("pinned"),
      public_gateway: z.boolean().default(false),
    })
    .default({}),
  big_file: z
    .object({
      threshold_bytes: z.number().default(104857600),
      threshold_display: z
        .object({
          value: z.number().default(100),
          unit: z.enum(["MB", "GB", "TB"]).default("MB"),
        })
        .default({}),
    })
    .default({}),
  // Compression preferences (compression.mdx §7). Per-media codec allow/deny + quality. Defaults chosen
  // for social-media compatibility (deny jpeg2000 for images, av1 for video). Audio disabled for now.
  compression: z
    .object({
      images: z
        .object({
          enabled: z.boolean().default(true),
          quality: z.enum(["low", "medium", "high", "lossless"]).default("medium"),
          prefer: z.array(z.string()).default(["jpeg", "webp"]),
          deny: z.array(z.string()).default(["jpeg2000"]),
        })
        .default({}),
      video: z
        .object({
          enabled: z.boolean().default(true),
          quality: z.enum(["low", "medium", "high", "lossless"]).default("medium"),
          prefer: z.array(z.string()).default(["h264", "hevc"]),
          deny: z.array(z.string()).default(["av1"]),
        })
        .default({}),
      audio: z
        .object({
          enabled: z.boolean().default(false), // audio not compressed for now (compression.mdx §1)
          quality: z.enum(["low", "medium", "high", "lossless"]).default("medium"),
          prefer: z.array(z.string()).default(["aac"]),
          deny: z.array(z.string()).default([]),
        })
        .default({}),
      preserve_resolution: z.boolean().default(true), // LOCKED on (compression.mdx §5)
      replace_original_to_trash: z.boolean().default(true), // recoverable replace (compression.mdx §8)
    })
    .default({}),
  // AI description providers (ai_description.mdx §5). Vision models the app may call to describe a local
  // image/video. Keys are OPTIONAL here — an empty key falls back to the matching env var
  // (GEMINI_API_KEY / XAI_API_KEY / OPENAI_API_KEY). `provider` = "auto" picks the first available that
  // supports the media kind. This is the ONE deliberate external network path; generation is always an
  // explicit user action (charter: separate from the local-only perceptual-fingerprint feature).
  ai: z
    .object({
      provider: z.enum(["auto", "gemini", "grok", "openai"]).default("auto"),
      gemini: z
        .object({
          api_key: z.string().nullable().default(null),
          // Default to the `gemini-flash-latest` ALIAS (image + video) so we auto-track Google's newest
          // GA Flash and never hard-break on a retirement. Kept in sync with DEFAULT_GEMINI_MODEL in
          // backend describe/models.ts; retired ids are auto-healed on load (ai_description.mdx §3.4).
          model: z.string().default("gemini-flash-latest"),
        })
        .default({}),
      grok: z
        .object({
          api_key: z.string().nullable().default(null),
          model: z.string().default("grok-2-vision-1212"),
        })
        .default({}),
      openai: z
        .object({
          api_key: z.string().nullable().default(null),
          model: z.string().default("gpt-4o"),
        })
        .default({}),
    })
    .default({}),
  sync_process: z
    .object({
      installed: z.boolean().default(false),
      enabled: z.boolean().default(false),
      interval_minutes: z.number().default(15),
      label: z.string().default("com.largefilebridge.sync"),
      last_run_at: iso.nullable().default(null),
      last_run_ok: z.boolean().nullable().default(null),
    })
    .default({}),
  // The DEVICE-REGISTRATION background worker (devices.mdx §12). A dedicated, every-10-minute pass whose
  // ONE job is: make sure THIS computer's device info (its self-owned devices/<self>.yaml) is written and
  // pushed up to each Git-backed storage's repo — pulling first (git fetch + auto-merge) EVERY run even
  // when there is nothing to change, so another computer's edits land here. Decoupled from the per-storage
  // IPFS `synced` opt-in: writing your own identity text to your OWN configured repo has no outward
  // footprint (sync_process.mdx §1), so it runs whenever the Git backbone is on. `enabled` is the "turn it
  // on" switch (the user's "I turn that on"). Same transparency contract (installed/on-off/last-run) as the
  // sync + scan workers (storage_local.mdx §13).
  device_process: z
    .object({
      installed: z.boolean().default(false),
      enabled: z.boolean().default(false),
      interval_minutes: z.number().default(10), // check every 10 min (devices.mdx §11)
      label: z.string().default("com.largefilebridge.device"),
      last_run_at: iso.nullable().default(null),
      last_run_ok: z.boolean().nullable().default(null),
      // ON BY DEFAULT (devices.mdx §11.1). Unlike scan/sync, the device worker needs no explicit user
      // Install — on first boot LFB auto-installs + enables its launchd job. This one-time latch records
      // that the auto-on happened, so if the user later turns it OFF it stays off (we never force it back).
      auto_provisioned: z.boolean().default(false),
    })
    .default({}),
  scan_process: z
    .object({
      installed: z.boolean().default(false),
      enabled: z.boolean().default(false),
      interval_hours: z.number().default(2), // scan at least every 2h so interest/big-file data stays fresh
      label: z.string().default("com.largefilebridge.scan"),
      last_run_at: iso.nullable().default(null),
      last_run_ok: z.boolean().nullable().default(null),
    })
    .default({}),
  // The live filesystem watcher (scan.mdx §2.2). Event-driven — NOT a scheduleTask: it runs only while
  // the web-app process is up (no plist/installed flag), subscribes to the OS's native change
  // notifications (FSEvents/inotify/ReadDirectoryChangesW) over scanner.roots, and on a qualifying
  // ADD/DELETE of a big or video/image/audio file kicks the coalesced discovery worker.
  watcher: z
    .object({
      enabled: z.boolean().default(true), // subscribe to file-change events while the app runs
      debounce_ms: z.number().default(1500), // quiet-period before a settled burst triggers a rescan
    })
    .default({}),
  // Security allow-list (security.mdx §2). Set once by the first-run Security Setup page, then read
  // LIVE on every request by identify.ts. `configured` gates the setup page; both switches are OR'd.
  access: z
    .object({
      configured: z.boolean().default(false), // has first-run Security Setup completed? (security.mdx §1)
      allow_companies: z.boolean().default(false), // section-1 checkbox — allow whole Workspace domains
      allowed_domains: z.array(z.string()).default([]), // bare domains, lowercased (no leading @)
      allow_individuals: z.boolean().default(false), // section-2 checkbox — allow exact accounts
      allowed_emails: z.array(z.string()).default([]), // exact emails, lowercased
    })
    .default({}),
  scanner: z
    .object({
      roots: z.array(z.string()).default([]),
      ignore_globs: z
        .array(z.string())
        .default(["**/node_modules/**", "**/.git/**", "**/.Trash/**"]),
      follow_symlinks: z.boolean().default(false),
    })
    .default({}),
  defaults: z
    .object({
      theme: z.enum(["system", "light", "dark"]).default("system"),
      density: z.enum(["comfortable", "compact"]).default("comfortable"),
    })
    .default({}),
  // Sticky per-entity flags keyed by ABSOLUTE path (menus.mdx §6.6, files.mdx, directories.mdx).
  // App-scope so they work for any file/dir whether or not it lives inside a registered repo. A
  // directory's flag applies to everything under it (checked by path-prefix at read time).
  file_flags: z
    .record(
      z.object({
        never_ipfs: z.boolean().default(false),
        no_compress: z.boolean().default(false),
      }),
    )
    .default({}),
  // The single computer-wide storage budget LFB may devote to ALL community content combined
  // (communities.mdx §5.2). Bytes. null = not yet set → the service proposes a recommendation.
  community_budget: z.number().nullable().default(null),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

// ── per-community subscription config (communities.mdx §8) ──────────────────
// `sync/c/<community_id>/config.yaml`: the user's per-community choices — intent (get/support) +
// backup mode (block|recommended|full) + the leading bookmark toggle. Computer-wide (owned by the
// machine, not the logged-in user), mirroring the repo/storage sync units.
export const CommunitySubscriptionSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  get: z.boolean().default(false),
  support: z.boolean().default(false),
  backup_mode: z.enum(["block", "recommended", "full"]).default("block"),
  bookmarked: z.boolean().default(false),
});
export type CommunitySubscriptionConfig = z.infer<typeof CommunitySubscriptionSchema>;

// ── per-repo config.yaml (storage.mdx §6.2 + repo_settings.mdx) ─────────────
export const RepoUnitConfigSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  repo: z
    .object({
      name: z.string().default(""),
      path: z.string().default(""),
      remote: z.string().nullable().default(null),
    })
    .default({}),
  synced: z.boolean().default(false),
  bookmarked: z.boolean().default(false), // user favorite (repos.mdx §8) — local, not synced to peers
  big_file_override: z
    .object({
      enabled: z.boolean().default(false),
      value: z.number().default(100),
      unit: z.enum(["MB", "GB", "TB"]).default("MB"),
    })
    .default({}),
  large_files: z
    .object({
      follow_gitignore: z.boolean().default(true),
      include_globs: z.array(z.string()).default([]),
      exclude_globs: z.array(z.string()).default([]),
    })
    .default({}),
  sync: z
    .object({
      pin_locally: z.boolean().default(true),
      fetch_missing: z.boolean().default(true),
      publish_manifest: z.boolean().default(true),
    })
    .default({}),
  access: z
    .object({
      shared: z.boolean().default(false),
      participants: z.array(z.string()).default([]),
    })
    .default({}),
  // Per-file decisions (one_repo.mdx §1). Keyed by relative path.
  decisions: z.record(z.enum(["sync", "ignore", "undecided"])).default({}),
});
export type RepoUnitConfig = z.infer<typeof RepoUnitConfigSchema>;

// ── computer-unit config.yaml (storage.mdx §8.1) ────────────────────────────
export const ComputerUnitConfigSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  synced: z.boolean().default(false),
  roots: z.array(z.string()).default([]),
  exclude_globs: z.array(z.string()).default([]),
  sync: z
    .object({
      pin_locally: z.boolean().default(true),
      fetch_missing: z.boolean().default(true),
      publish_manifest_ipns: z.boolean().default(true),
    })
    .default({}),
  decisions: z.record(z.enum(["sync", "ignore", "undecided"])).default({}),
});
export type ComputerUnitConfig = z.infer<typeof ComputerUnitConfigSchema>;

// ── per-storage machine-local config.yaml (storage_settings.mdx §5) ─────────
// sync/s/<storage_id>/config.yaml — the local "settings file" distinct from the SHARED storage.yaml.
// Holds THIS computer's choices: keep .lfbridge/ + where, and which backing locations are ON + their
// absolute local paths. The `storage:` block is an identity mirror written by discovery (read-only).
const StorageBackingSchema = z
  .object({
    enabled: z.boolean().default(false),
    path: z.string().nullable().default(null),
  })
  .default({});
export const StorageUnitConfigSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  storage: z
    .object({
      id: z.string().default(""),
      name: z.string().default(""),
      type: z.enum(["local", "repo", "personal", "company", "community"]).default("personal"),
      root: z.string().default(""),
    })
    .default({}),
  // The per-storage IPFS-pinning opt-in (sync_process.mdx §1 semantics, mirrored for storages). Default
  // OFF — a storage is known & visited every pass, but its mapped-dir bytes are added/pinned/fetched only
  // once the user opts in. Charter: never pin content without an explicit, user-confirmed action.
  synced: z.boolean().default(false),
  lfbridge: z
    .object({
      enabled: z.boolean().default(true), // keep .lfbridge/ on this computer (default ON — §3)
      path: z.string().nullable().default(null), // null = default <root>/.lfbridge/
    })
    .default({}),
  backing: z
    .object({
      dedicated_repo: StorageBackingSchema,
      google_drive: StorageBackingSchema,
      dropbox: StorageBackingSchema,
    })
    .default({}),
});
export type StorageUnitConfig = z.infer<typeof StorageUnitConfigSchema>;

// ── manifest.yaml (storage.mdx §9.1) ────────────────────────────────────────
export const ManifestFileSchema = z.object({
  path: z.string(),
  cid: z.string().nullable().default(null),
  size: z.number().default(0),
  modified_at: iso.optional(),
  sha256: z.string().nullable().default(null),
  pinned_by: z.array(z.string()).default([]),
});
export const ManifestSchema = z.object({
  schema_version: z.number().default(1),
  unit: z.enum(["repo", "computer", "storage"]).default("repo"),
  generated_at: iso.optional(),
  files: z.array(ManifestFileSchema).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

// ── status.yaml (scan.mdx §6) ───────────────────────────────────────────────
export const UnitStatusSchema = z.object({
  schema_version: z.number().default(1),
  last_scan_at: iso.nullable().default(null),
  last_sync_at: iso.nullable().default(null),
  scan_source: z.enum(["scheduled", "manual"]).default("scheduled"),
  effective_threshold_bytes: z.number().default(104857600),
  big_file_count: z.number().default(0),
  big_file_bytes: z.number().default(0),
  repo_state: z.enum(["present", "missing"]).default("present"),
  last_error: z.string().nullable().default(null),
  folder_name: z.string().optional(),
  // The full discovered big-file candidate list — feeds the files table (one_repo.mdx §4).
  // Metadata only (scan.mdx §1): path relative to unit root, size, mtime.
  candidates: z
    .array(
      z.object({
        path: z.string(),
        size: z.number().default(0),
        modified_at: iso.optional(),
      }),
    )
    .default([]),
  changes_since_last_scan: z
    .object({
      added: z.array(z.string()).default([]),
      grew: z.array(z.string()).default([]),
      shrank: z.array(z.string()).default([]),
      moved: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
      deleted: z.array(z.string()).default([]),
    })
    .default({}),
});
export type UnitStatus = z.infer<typeof UnitStatusSchema>;

// ── peers.yaml (storage.mdx §11) ────────────────────────────────────────────
export const PeersSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  peers: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        ipfs_peer_id: z.string().nullable().default(null),
        owner: z.string(),
        last_seen: iso.nullable().default(null),
      }),
    )
    .default([]),
});
export type Peers = z.infer<typeof PeersSchema>;

// ── web-session history (sessions.mdx §4) ────────────────────────────────────
// One usage window measured from page renders — NOT the auth session (storage.mdx §10). `ended_at`
// is null while open, otherwise it EQUALS `last_activity_at` (the session ends at the last render,
// not at the moment the 4-hour idle timer fires). Drives the > 48h "stale return" auto-sync.
export const SessionRecordSchema = z.object({
  started_at: iso,
  last_activity_at: iso,
  ended_at: iso.nullable().default(null),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

// ── mapped_dirs.yaml (syncable_data_location.mdx §3) ────────────────────────
// The SHARED list of source directory hierarchies a company/personal storage covers. Travels in the
// SDL (`<root>/.lfbridge/mapped_dirs.yaml`); every device agrees on the SET (stable `key` + label),
// while each device's graft (devices.mdx) re-roots each key to its own absolute path. `canonical` is
// the writer's path — advisory only, never trusted by a reader.
export const MappedDirEntrySchema = z.object({
  key: z.string(), // stable id, referenced by every device's graft (devices.mdx)
  label: z.string().default(""), // human name shown in the UI
  canonical: z.string().nullable().default(null), // the WRITER's path — advisory only; each device re-roots it
  recursive: z.boolean().default(true), // the whole subtree is in scope (always true today)
});
export const MappedDirsSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  mapped: z.array(MappedDirEntrySchema).default([]),
});
export type MappedDirs = z.infer<typeof MappedDirsSchema>;

// ── devices/<device>.yaml (devices.mdx §3) ──────────────────────────────────
// One SELF-OWNED file per computer in the SDL's `.lfbridge/devices/`. Carries this device's identity,
// its per-storage sync schedule, and the GRAFT — how the storage's machine-independent mapped-dir keys
// map onto THIS computer's absolute local paths (devices.mdx §4).
export const DeviceScheduleWindowSchema = z.object({
  days: z.array(z.string()).default([]), // e.g. ["mon","tue",…]
  from: z.string().default(""), // "02:00"
  to: z.string().default(""), // "04:00"
});
export const DeviceGraftEntrySchema = z.object({
  local_path: z.string().nullable().default(null), // where THIS computer keeps this mapped dir (null = absent here)
  wanted: z.boolean().default(true), // does this device want this hierarchy at all
});
export const DeviceFileSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  device: z
    .object({
      id: z.string().default(""), // the minted UUID (config.yaml→computer.id) — the durable key
      name: z.string().default(""), // the nice name the user set from the web app
      owner: z.string().nullable().default(null), // the allow-listed user this computer belongs to
      ipfs_peer_id: z.string().nullable().default(null), // for peer dialing (may change; id above does not)
      hardware: DeviceHardwareSchema, // this device's fingerprint (devices.mdx §7) — travels with the SDL
    })
    .default({}),
  schedule: z
    .object({
      enabled: z.boolean().default(true), // does this device sync this storage at all
      interval_minutes: z.number().default(15), // cadence (default matches the 15-min background pass)
      windows: z.array(DeviceScheduleWindowSchema).default([]), // optional specific times/windows
    })
    .default({}),
  // one entry per mapped source directory keyed in mapped_dirs.yaml (§4)
  graft: z.record(DeviceGraftEntrySchema).default({}),
});
export type DeviceFile = z.infer<typeof DeviceFileSchema>;

// ── bookmarks.yaml (syncable_data_location.mdx §4.4) ────────────────────────
// The user's starred files, a property of the STORAGE (not the computer), so it travels in the SDL.
export const BookmarksSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  bookmarked: z.array(z.string()).default([]), // relpaths (relative to the storage root / mapped dir)
});
export type BookmarksDoc = z.infer<typeof BookmarksSchema>;

// ── analysis/<relpath>/compression.yaml (syncable_data_location.mdx §4.3) ────
// The travelling compression record: what a file WAS before it was compressed + the before/after sizes.
// Written once on an explicit compress, then reused by every computer that carries the storage.
export const CompressionRecordSchema = z.object({
  source: z.string(), // the CURRENT (compressed) path, relative to the storage root / mapped dir
  original: z.object({
    name: z.string(), // the ORIGINAL filename + extension before compression
    extension: z.string(), // the original extension (no leading dot)
    size: z.number(), // bytes BEFORE
  }),
  compressed: z.object({
    codec: z.string().nullable().default(null), // the codec we compressed to (charter: X-safe, never AV1)
    size: z.number(), // bytes AFTER
    ratio: z.number(), // after / before
    at: iso, // when compressed
  }),
});
export type CompressionRecordDoc = z.infer<typeof CompressionRecordSchema>;

// ── File System page persisted view state (directories.mdx §1.3) ─────────────
// The open column chain + selection + header filters the user last had on the File System page, so
// leaving and returning drops them right back where they were. Personal, cosmetic view state — never
// gates access, never derives identity (sessions.mdx §1). Restored on mount, written debounced.
export const FileSystemViewSchema = z.object({
  // Open column chain, root → deepest, left to right. Each is an absolute directory path.
  columns: z.array(z.string()).default([]),
  // The 1+ entries highlighted when the user left (§1.2 multi-select). May be files or directories.
  selection: z.array(z.string()).default([]),
  // The §1.4 header checkboxes (all default ON). Held forward-compatibly; the browser wires the ones
  // whose UI exists and ignores the rest until they land.
  filters: z
    .object({
      only_large: z.boolean().default(true),
      videos: z.boolean().default(true),
      images: z.boolean().default(true),
      audio: z.boolean().default(true),
    })
    .default({}),
  updated_at: iso.optional(),
});
export type FileSystemView = z.infer<typeof FileSystemViewSchema>;

// ── per-user config.yaml (storage.mdx §4) ───────────────────────────────────
export const UserConfigSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  ui: z
    .object({
      theme: z.enum(["system", "light", "dark"]).default("system"),
      density: z.enum(["comfortable", "compact"]).default("comfortable"),
      last_route: z.string().default("/"),
    })
    .default({}),
  tables: z.record(z.unknown()).default({}),
  // The File System page's persisted view state (directories.mdx §1.3). A fresh user with no block
  // reads back the schema defaults (empty columns/selection, all filters ON) — never an error.
  file_system: FileSystemViewSchema.default({}),
  // Last 5 web sessions, newest first (sessions.mdx §4). At most one open (ended_at null), at index 0.
  sessions: z.array(SessionRecordSchema).default([]),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;
