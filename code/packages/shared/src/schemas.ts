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
  .prefault({});
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
    .prefault({}),
  computer: z
    .object({
      id: z.string().optional(),
      label: z.string().default("this-computer"),
      ipfs_peer_id: z.string().nullable().default(null),
      hardware: DeviceHardwareSchema, // this machine's fingerprint (devices.mdx §7) — seeded on first run
    })
    .prefault({}),
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
    .prefault({}),
  // Mass-parallelization policy (parallelization.mdx §4). `max_core_fraction` ∈ (0,1] tunes the
  // MASS-COMPUTE core budget — round(cores × fraction) — used for user-kicked-off batch CPU work
  // (compression, fingerprinting, batch transcode). Default 0.9 = "use up to ~90% of cores". Read LIVE
  // by shared/concurrency.ts coreBudget(), so a change takes effect on the next bulk run with no restart.
  // The responsive budget (cores − 2) for pin/scan is a fixed safety floor and is NOT configured here.
  // `max_memory_fraction` ∈ (0,1] is concurrency's SECOND budget (memory.mdx §2.1) — the fraction of the V8
  // heap ceiling that in-flight job payloads may reserve. Default 0.5: half the heap for payloads leaves half
  // for the app, the fs index, the queue and GC headroom. This is the knob that would have prevented the
  // 2026-07-15 OOM — 24 concurrent describes each pinning a multi-MB base64 upload reached 4.1GB and V8
  // aborted. Read LIVE by shared/concurrency.ts memoryBudget() at admission, so a change lands on the next
  // task with no restart.
  performance: z
    .object({
      max_core_fraction: z.number().min(0.01).max(1).default(0.9),
      max_memory_fraction: z.number().min(0.05).max(1).default(0.5),
    })
    .prefault({}),
  // Transcription engine + parallelism (transcribe_engine.mdx §5.4/§6). `engine`: auto (Apple SpeechAnalyzer
  // when the machine runs macOS 26+, else the mac/Whisper Small fallback — qwen is NOT auto-selected) /
  // speech / mac / qwen. `max_parallel`: optional hard cap overriding the auto per-machine calibration
  // (§5.1); null = auto. `model_installed_bytes`: the MEASURED on-disk weight size stored after a real qwen
  // provision (§3.1), so the disk estimate becomes exact. `model_consent`: the remembered first-time consent
  // decision (§3.2), so the popup does not nag on every file (approved / declined / use_fallback; null = never asked).
  transcribe: z
    .object({
      engine: z.enum(["auto", "speech", "qwen", "mac"]).default("auto"),
      max_parallel: z.number().int().min(1).nullable().default(null),
      model_installed_bytes: z.number().nullable().default(null),
      model_consent: z.enum(["approved", "declined", "use_fallback"]).nullable().default(null),
    })
    .prefault({}),
  // OCR — read the text out of the pixels (ocr.mdx §17). `engine`: auto (Apple Vision when available, else
  // the vendored tesseract.js fallback — §3.2) / vision / tesseract. `video_stride_seconds` (default 15) is
  // the LOCKED sampling stride (§2.2.1): a slide lives 30s–5min and a chyron 10–30s, so 15s catches them
  // while sampling 0.07% of a 30fps stream. `max_frames` (default 1000) bounds a pathological input (a
  // 10-hour stream would emit 2,400 frames at 15s); when it bites, the artifact records truncated:true and
  // the UI SAYS so — no silent caps (§15.2 rule 7). `language` is BCP-47; a language whose data is not
  // vendored is a PERMISSIONED download, never silent (§3.3).
  ocr: z
    .object({
      engine: z.enum(["auto", "vision", "tesseract"]).default("auto"),
      video_stride_seconds: z.number().min(1).max(600).default(15),
      max_frames: z.number().int().min(1).max(10000).default(1000),
      language: z.string().default("en-US"),
    })
    .prefault({}),
  // `threshold_bytes` (100 MB = GitHub's hard limit) gates the bridge payload — a git-ignored file the
  // user already chose to keep out of git. `checked_in_threshold_bytes` (50 MB = GitHub's *warning* line)
  // is the separate, lower gate for the opposite case: a file that IS checked in and probably shouldn't
  // be. It must stay <= threshold_bytes; the nudge fires before GitHub blocks the push (scan.mdx §4.2).
  big_file: z
    .object({
      threshold_bytes: z.number().default(104857600),
      threshold_display: z
        .object({
          value: z.number().default(100),
          unit: z.enum(["MB", "GB", "TB"]).default("MB"),
        })
        .prefault({}),
      checked_in_threshold_bytes: z.number().default(52428800),
      checked_in_threshold_display: z
        .object({
          value: z.number().default(50),
          unit: z.enum(["MB", "GB", "TB"]).default("MB"),
        })
        .prefault({}),
    })
    .prefault({}),
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
          // File-type conversion policy (images.mdx §2, settings.mdx §4.1.1). Both DEFAULT ON.
          // convert_types: may a compress CHANGE the format to a better/compatible target (HEIC→JPEG,
          // PNG→JPEG)? false = format-preserving (re-encode in place, never change the extension).
          convert_types: z.boolean().default(true),
          // skip_exts: per-extension OPT-OUT (default [] = every recognized ext is in scope). Lowercase,
          // leading-dot (".heic"). An ext listed here is skipped entirely ("excluded by settings").
          skip_exts: z.array(z.string()).default([]),
        })
        .prefault({}),
      video: z
        .object({
          enabled: z.boolean().default(true),
          quality: z.enum(["low", "medium", "high", "lossless"]).default("medium"),
          prefer: z.array(z.string()).default(["h264", "hevc"]),
          deny: z.array(z.string()).default(["av1"]),
          convert_types: z.boolean().default(true), // same policy for video (images.mdx §1.4)
          skip_exts: z.array(z.string()).default([]),
        })
        .prefault({}),
      audio: z
        .object({
          enabled: z.boolean().default(false), // audio not compressed for now (compression.mdx §1)
          quality: z.enum(["low", "medium", "high", "lossless"]).default("medium"),
          prefer: z.array(z.string()).default(["aac"]),
          deny: z.array(z.string()).default([]),
          convert_types: z.boolean().default(true), // uniform shape (audio disabled; fields unused)
          skip_exts: z.array(z.string()).default([]),
        })
        .prefault({}),
      preserve_resolution: z.boolean().default(true), // LOCKED on (compression.mdx §5)
      replace_original_to_trash: z.boolean().default(true), // recoverable replace (compression.mdx §8)
    })
    .prefault({}),
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
          // GA Flash and never hard-break on a retirement. Kept aligned with DEFAULT_GEMINI_MODEL in
          // backend describe/models.ts; retired ids are auto-healed on load (ai_description.mdx §3.4).
          model: z.string().default("gemini-flash-latest"),
        })
        .prefault({}),
      grok: z
        .object({
          api_key: z.string().nullable().default(null),
          model: z.string().default("grok-2-vision-1212"),
        })
        .prefault({}),
      openai: z
        .object({
          api_key: z.string().nullable().default(null),
          model: z.string().default("gpt-4o"),
        })
        .prefault({}),
    })
    .prefault({}),
  // The IPFS add/pin background worker (pin_process.mdx). Renamed from the legacy `sync_process` block;
  // the one-time startup migration rewrites an old on-disk `sync_process` (and its
  // `com.largefilebridge.sync` label) into this shape.
  pin_process: z
    .object({
      installed: z.boolean().default(false),
      enabled: z.boolean().default(false),
      interval_minutes: z.number().default(15),
      label: z.string().default("com.largefilebridge.pin"),
      last_run_at: iso.nullable().default(null),
      last_run_ok: z.boolean().nullable().default(null),
    })
    .prefault({}),
  // The DEVICE-REGISTRATION background worker (devices.mdx §12). A dedicated, every-10-minute pass whose
  // ONE job is: make sure THIS computer's device info (its self-owned devices/<self>.yaml) is written and
  // pushed up to each Git-backed storage's repo — pulling first (git fetch + auto-merge) EVERY run even
  // when there is nothing to change, so another computer's edits land here. Decoupled from the per-storage
  // IPFS `pinned` opt-in: writing your own identity text to your OWN configured repo has no outward
  // footprint (pin_process.mdx §1), so it runs whenever the Git backbone is on. `enabled` is the "turn it
  // on" switch (the user's "I turn that on"). Same transparency contract (installed/on-off/last-run) as the
  // pin + scan workers (storage_local.mdx §13).
  device_process: z
    .object({
      installed: z.boolean().default(false),
      enabled: z.boolean().default(false),
      interval_minutes: z.number().default(10), // check every 10 min (devices.mdx §11)
      label: z.string().default("com.largefilebridge.device"),
      last_run_at: iso.nullable().default(null),
      last_run_ok: z.boolean().nullable().default(null),
      // ON BY DEFAULT (devices.mdx §11.1). Unlike scan/pin, the device worker needs no explicit user
      // Install — on first boot LFB auto-installs + enables its launchd job. This one-time latch records
      // that the auto-on happened, so if the user later turns it OFF it stays off (we never force it back).
      auto_provisioned: z.boolean().default(false),
    })
    .prefault({}),
  scan_process: z
    .object({
      installed: z.boolean().default(false),
      enabled: z.boolean().default(false),
      interval_hours: z.number().default(2), // scan at least every 2h so interest/big-file data stays fresh
      label: z.string().default("com.largefilebridge.scan"),
      last_run_at: iso.nullable().default(null),
      last_run_ok: z.boolean().nullable().default(null),
    })
    .prefault({}),
  // The live filesystem watcher (scan.mdx §2.2). Event-driven — NOT a scheduleTask: it runs only while
  // the web-app process is up (no plist/installed flag), subscribes to the OS's native change
  // notifications (FSEvents/inotify/ReadDirectoryChangesW) over scanner.roots, and on a qualifying
  // ADD/DELETE of a big or video/image/audio file kicks the coalesced discovery worker.
  watcher: z
    .object({
      enabled: z.boolean().default(true), // subscribe to file-change events while the app runs
      debounce_ms: z.number().default(1500), // quiet-period before a settled burst triggers a rescan
    })
    .prefault({}),
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
    .prefault({}),
  scanner: z
    .object({
      roots: z.array(z.string()).default([]),
      ignore_globs: z
        .array(z.string())
        .default(["**/node_modules/**", "**/.git/**", "**/.Trash/**"]),
      follow_symlinks: z.boolean().default(false),
    })
    .prefault({}),
  // The user's own forge accounts (repo_company_mapping.mdx §4). A repo whose git-remote owner matches one of
  // these derives to PERSONAL, not a company — so your own github.com/<you>/<repo> isn't mislabeled as company
  // "<you>". `host` is optional: when omitted the owner matches on any known forge host, else only on that host.
  personal_accounts: z
    .array(z.object({ host: z.string().optional(), owner: z.string() }))
    .default([]),
  defaults: z
    .object({
      theme: z.enum(["system", "light", "dark"]).default("system"),
      density: z.enum(["comfortable", "compact"]).default("comfortable"),
    })
    .prefault({}),
  // Sticky per-entity flags keyed by ABSOLUTE path (menus.mdx §6.6, files.mdx, directories.mdx).
  // App-scope so they work for any file/dir whether or not it lives inside a registered repo. A
  // directory's flag applies to everything under it (checked by path-prefix at read time).
  file_flags: z
    .record(
      z.string(),
      z.object({
        never_ipfs: z.boolean().default(false),
        no_compress: z.boolean().default(false),
      }),
    )
    .prefault({}),
  // The single computer-wide storage budget LFB may devote to ALL community content combined
  // (communities.mdx §5.2). Bytes. null = not yet set → the service proposes a recommendation.
  community_budget: z.number().nullable().default(null),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

// ── per-community subscription config (communities.mdx §8) ──────────────────
// `pin/c/<community_id>/config.yaml`: the user's per-community choices — intent (get/support) +
// backup mode (block|recommended|full) + the leading bookmark toggle. Computer-wide (owned by the
// machine, not the logged-in user), mirroring the repo/storage pin units.
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
    .prefault({}),
  pinned: z.boolean().default(false),
  bookmarked: z.boolean().default(false), // user favorite (repos.mdx §8) — local, not shared to peers
  big_file_override: z
    .object({
      enabled: z.boolean().default(false),
      value: z.number().default(100),
      unit: z.enum(["MB", "GB", "TB"]).default("MB"),
    })
    .prefault({}),
  large_files: z
    .object({
      follow_gitignore: z.boolean().default(true),
      include_globs: z.array(z.string()).default([]),
      exclude_globs: z.array(z.string()).default([]),
    })
    .prefault({}),
  pin: z
    .object({
      pin_locally: z.boolean().default(true),
      fetch_missing: z.boolean().default(true),
      publish_manifest: z.boolean().default(true),
    })
    .prefault({}),
  access: z
    .object({
      shared: z.boolean().default(false),
      participants: z.array(z.string()).default([]),
    })
    .prefault({}),
  // Where this repo's transcripts / AI descriptions / OCR text are written (repo_settings.mdx §4/§5,
  // placement_radios.mdx, ocr.mdx §5.3). Frozen wire enum lfbridge | beside | sync_repo; all default to
  // lfbridge. All three are Category-A content artifacts under the same kind-resolved tracking base, so they
  // share one radio SHAPE — the OCR instance's parameterized noun is "OCR text".
  artifacts: z
    .object({
      transcription_placement: z.enum(["lfbridge", "beside", "sync_repo"]).default("lfbridge"),
      ai_description_placement: z.enum(["lfbridge", "beside", "sync_repo"]).default("lfbridge"),
      ocr_placement: z.enum(["lfbridge", "beside", "sync_repo"]).default("lfbridge"),
    })
    .prefault({}),
  // Whether THIS repo additionally mirrors its Category-B tracking state (repo_storage.yaml, sidecars,
  // history, decisions.yaml, manifest.yaml) to the owning company/Personal storage's SYNC REPO so it travels
  // (artifact_placement_policy.mdx §4). Default OFF — Local-Storage-only. Enabled only when the owner has a
  // sync repo configured; toggled from the per-repo settings page (repo_settings.mdx §2.9).
  sync_repo: z.object({ enabled: z.boolean().default(false) }).prefault({}),
  // The LOCAL grouping override (repo_company_mapping.mdx §5.2). ABSENT (null) => auto-derive the owner from
  // the git remote (source:"auto"). PRESENT => the user reassigned this repo (source:"manual"), sticky across
  // rescans and NEVER overwritten by a teammate. `company_id` is set only when kind==="company". Machine-local
  // (like `bookmarked`); the travelling company-ownership ASSERTION lives in the company sync repo's
  // owner_map.yaml instead (repo_owner_propagation.mdx §2).
  owner_override: z
    .object({
      kind: z.enum(["personal", "company"]),
      company_id: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  // Per-file decisions (one_repo.mdx §1). Keyed by relative path. The "sync" value is a FROZEN wire
  // literal (= add-to-IPFS / pin) that travels between computers — do not rename it.
  decisions: z.record(z.string(), z.enum(["sync", "ignore", "undecided"])).default({}),
});
export type RepoUnitConfig = z.infer<typeof RepoUnitConfigSchema>;

// ── company ownership assertions: <syncRepo>/owner_map.yaml (repo_owner_propagation.mdx §2) ──
// Committed at the company sync-repo ROOT and travels the company git backbone; union-merges on pull (each
// key is self-contained, keyed by the repo's NORMALIZED git remote — the only identity portable across
// members' machines). `withdrawn: true` is a TOMBSTONE (never a hard delete) so an un-assign also travels.
export const OwnerMapAssertionSchema = z.object({
  remote: z.string().default(""), // the canonical remote URL as captured (for display)
  asserted_by: z.string().nullable().default(null), // the asserting member's email (from the auth session)
  asserted_at: iso.optional(),
  withdrawn: z.boolean().default(false),
});
export type OwnerMapAssertion = z.infer<typeof OwnerMapAssertionSchema>;

export const OwnerMapSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  company_id: z.string().default(""),
  assertions: z.record(z.string(), OwnerMapAssertionSchema).default({}), // keyed "host/owner/repo"
});
export type OwnerMap = z.infer<typeof OwnerMapSchema>;

// ── remembered declines: ~/T/_large_files_bridge/company_mapping_declines.yaml (repo_owner_propagation.mdx §4.4) ──
// MACHINE-LOCAL (never travels). A declined assertion is keyed by remote + company so a DIFFERENT company
// later asserting the same repo still surfaces, and a newer assertion (fresher asserted_at) supersedes it.
export const CompanyMappingDeclinesSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  declined: z
    .array(
      z.object({
        remote_key: z.string(),
        company_id: z.string(),
        declined_at: iso.optional(),
      }),
    )
    .default([]),
});
export type CompanyMappingDeclines = z.infer<typeof CompanyMappingDeclinesSchema>;

// ── per-file decision ledger: <repo>/.lfbridge/decisions.yaml (decisions.mdx) ─
// The SHARED, team-visible decision log — committed and union-merged by the git backbone so a whole
// team shares ONE set of decisions. TWO INDEPENDENT AXES per file (ipfs = Add to IPFS/pin; gitignore =
// Add to git ignore), plus who/when/the Storage ID. It is an APPEND LOG of events folded on read
// (latest decided_at per (sid, path) wins — decisions.mdx §5). Distinct from the frozen
// `decisions:` enum map above, which is the machine-local RECONCILED CACHE of this ledger's IPFS axis.
export const DecisionEventSchema = z.object({
  sid: z.string(), // Storage ID binding the decision to its storage (decisions.mdx §3.1)
  path: z.string(), // repo-relative path — the stable key even when the file is ABSENT locally
  fingerprint: z.string().nullable().default(null), // content fingerprint from files.yaml (advisory)
  asked: z.boolean().default(true), // we surfaced the file and the user answered (presence ⇒ Decided)
  ipfs: z.boolean().default(false), // AXIS 1 — Add to IPFS (pin)
  gitignore: z.boolean().default(false), // AXIS 2 — Add to git ignore
  decided_by: z.string().nullable().default(null), // allow-listed email of the deciding user
  decided_at: iso, // ISO-8601 UTC — also the fold tiebreaker
});
export type DecisionEvent = z.infer<typeof DecisionEventSchema>;

export const DecisionsLedgerSchema = z.object({
  schema_version: z.number().default(1),
  events: z.array(DecisionEventSchema).default([]),
});
export type DecisionsLedger = z.infer<typeof DecisionsLedgerSchema>;

// ── TO DO batch: ~/T/_large_files_bridge/_do_batches/<slug>_2_do.yaml (to_do_batches.mdx §3) ──
// The MACHINE-LOCAL, disposable per-storage recommendation bundle the TO DO Batch Calc Engine writes
// each scan recalc (recalculate-and-replace). NOT committed, NOT team-shared. The camelCase keys mirror
// the @lfb/shared DTOs (TodoBatchSummary/Detail) so the store maps 1:1 with no rename layer.
export const TodoCategoryEnum = z.enum([
  "compress_video",
  "compress_image",
  "git_ignore",
  "pin",
  "pull_down",
  "transcribe_video",
  "transcribe_audio",
]);
export const TodoBatchItemSchema = z.object({
  path: z.string(),
  sizeBytes: z.number().default(0),
  category: TodoCategoryEnum,
  cid: z.string().nullable().optional(),
  pinnedOn: z.array(z.string()).optional(),
  estCompressedBytes: z.number().optional(),
  recommend: z
    .object({ ipfs: z.boolean().optional(), gitignore: z.boolean().optional(), compress: z.boolean().optional() })
    .prefault({}),
});
export const TodoCategoryTotalSchema = z.object({ count: z.number(), reclaimableBytes: z.number().optional() });
export const TodoBatchDocSchema = z.object({
  schema_version: z.number().default(1),
  id: z.string().default(""),
  scope: z.enum(["personal", "dropbox", "gdrive", "repo", "company", "community"]).default("repo"),
  storageName: z.string().default(""),
  storageRoot: z.string().default(""),
  kind: z.enum(["todo", "transcribe"]).default("todo"),
  pattern: z.enum(["compress", "git_ignore", "pull_down", "pin", "transcribe", "mixed"]).default("mixed"),
  repoId: z.string().optional(),
  totals: z.record(z.string(), TodoCategoryTotalSchema).default({}),
  items: z.array(TodoBatchItemSchema).default([]),
  dismissed: z.boolean().default(false),
  dismissedAt: z.string().nullable().default(null),
  computedAt: iso.default(""),
});
export type TodoBatchDoc = z.infer<typeof TodoBatchDocSchema>;

// ── repo_storage.yaml: <repo>/.lfbridge/repo_storage.yaml (repo_tracking_scheme.mdx §2) ──
// The single repo-WIDE settings-and-state file. HARD SCHEMA RULE: the ONLY level-one key is
// `repo_storage:` — everything else is nested at level two or deeper. Written automatically on enlist,
// updated by every scan and user action. It is a git-ignored WORKING artifact (not a committed traveller).
export const RepoStorageCountsSchema = z.object({
  special: z.number().default(0), // files that matched the special-file test (special_files.mdx)
  large: z.number().default(0),
  ipfs_pinned: z.number().default(0), // pinned by us OR observed already-pinned outside us
  videos: z.number().default(0),
  images: z.number().default(0),
  audio: z.number().default(0),
  compressible: z.number().default(0), // media that looks uncompressed (compression.mdx baseline)
  transcribable: z.number().default(0), // video + audio that could be transcribed (Transcribe.mdx)
  transcribed: z.number().default(0),
});
export type RepoStorageCounts = z.infer<typeof RepoStorageCountsSchema>;

export const RepoStorageDocSchema = z.object({
  repo_storage: z.object({
    schema_version: z.number().default(1),
    name: z.string().default(""), // defaults to repo folder name; user-editable (repo_settings.mdx)
    enlisted: z
      .object({
        at: iso.optional(),
        by: z.string().nullable().default(null), // allow-listed Google email that enlisted it
        on_device: z.string().default(""), // unique device name (devices.mdx) that enlisted it
      })
      .prefault({}),
    counts: RepoStorageCountsSchema.prefault({}),
    policy: z
      .object({
        recommend_ipfs_pin: z.boolean().default(true),
        recommend_compress: z.boolean().default(true),
        recommend_transcribe: z.boolean().default(false),
      })
      .prefault({}),
    last_scan: z
      .object({
        at: iso.optional(),
        on_device: z.string().default(""),
        headless: z.boolean().default(false), // true when a background scan wrote this
      })
      .prefault({}),
  }),
});
export type RepoStorageDoc = z.infer<typeof RepoStorageDocSchema>;

// ── per-file sidecar: <repo>/.lfbridge/files/<mirrored-path>/<name>.yaml (repo_tracking_scheme.mdx §3) ──
// One small YAML PER SPECIAL FILE. HARD SCHEMA RULE: the ONLY level-one key is `file:`. Carries the
// file's identity + an APPEND-ONLY `events:` history. Every event is stamped at(UTC)/on_device/by (the
// allow-listed email, or the sentinel `not-lfbridge` for actions done OUTSIDE us that a scan observed).
export const PerceptualFingerprintSchema = z.object({
  algo: z.string(), // pdq (image) | vpdq (video) | blockhash (fallback)
  value: z.string(), // 64-hex (32 bytes) for pdq/blockhash
  quality: z.number().nullable().default(null), // PDQ quality score (image); low → excluded from auto-match
  frames_ref: z.string().optional(), // for large vPDQ frame lists: path to a `.vpdq` sidecar file
});
export type PerceptualFingerprint = z.infer<typeof PerceptualFingerprintSchema>;

// One event in a sidecar's append-only history. Common fields are validated; kind-specific fields
// (ipfs, before/after, codec, format, output, note, …) pass through so the kind list stays extensible.
export const FileEventSchema = z
  .object({
    kind: z.enum([
      "observed",
      "decision",
      "ipfs_pin",
      "compress",
      "convert",
      "transcribe",
      "pull",
    ]),
    at: iso, // ISO-8601 UTC
    on_device: z.string().default(""), // unique device name (devices.mdx)
    by: z.string().nullable().default(null), // allow-listed email, or the sentinel "not-lfbridge"
  })
  .passthrough();
export type FileEvent = z.infer<typeof FileEventSchema>;

export const FileSidecarSchema = z.object({
  file: z.object({
    path: z.string(), // repo-relative path (stable key even when absent locally)
    name: z.string().default(""),
    categories: z.array(z.string()).default([]), // special_files.mdx categories (why this file is special)
    size: z.number().nullable().default(null),
    created: iso.optional(),
    modified: iso.optional(),
    hash: z.string().nullable().default(null), // exact content hash (files.yaml fingerprint)
    fingerprint: PerceptualFingerprintSchema.nullable().default(null), // perceptual fp (media only)
    first_seen: z
      .object({ at: iso.optional(), on_device: z.string().default("") })
      .prefault({}),
    events: z.array(FileEventSchema).default([]),
  }),
});
export type FileSidecar = z.infer<typeof FileSidecarSchema>;

// ── decision policy: <repo>/.lfbridge/decisions_policy.yaml (decisions.mdx §9/§14) ──
// The SHARED, per-repo default-decision policy + attribution mode. Travels in the SDL alongside the
// ledger so the whole team inherits one rule. Default of the default is OFF (new files stay Undecided).
export const DecisionKindPolicySchema = z.object({
  mode: z.enum(["auto", "ask"]).default("ask"), // auto-decide on discovery, or leave Undecided + warn
  ipfs: z.boolean().default(true), // the default IPFS axis when mode=auto
  gitignore: z.boolean().default(true), // the default git-ignore axis when mode=auto
});
export type DecisionKindPolicy = z.infer<typeof DecisionKindPolicySchema>;

export const DecisionPolicyDocSchema = z.object({
  schema_version: z.number().default(1),
  // null ⇒ auto: resolve from the remote (public → handle, else email) — decisions.mdx §14.
  attribution: z.enum(["email", "handle", "anonymous"]).nullable().default(null),
  media: DecisionKindPolicySchema.default({ mode: "ask", ipfs: true, gitignore: true }),
  other: DecisionKindPolicySchema.default({ mode: "ask", ipfs: false, gitignore: false }),
  set_by: z.string().nullable().default(null),
  set_at: iso.optional(),
});
export type DecisionPolicyDoc = z.infer<typeof DecisionPolicyDocSchema>;

// ── computer-unit config.yaml (storage.mdx §8.1) ────────────────────────────
export const ComputerUnitConfigSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  pinned: z.boolean().default(false),
  roots: z.array(z.string()).default([]),
  exclude_globs: z.array(z.string()).default([]),
  pin: z
    .object({
      pin_locally: z.boolean().default(true),
      fetch_missing: z.boolean().default(true),
      publish_manifest_ipns: z.boolean().default(true),
    })
    .prefault({}),
  // "sync" is a FROZEN wire literal (= add-to-IPFS / pin) that travels between computers — do not rename.
  decisions: z.record(z.string(), z.enum(["sync", "ignore", "undecided"])).default({}),
});
export type ComputerUnitConfig = z.infer<typeof ComputerUnitConfigSchema>;

// ── per-storage machine-local config.yaml (storage_settings.mdx §5) ─────────
// pin/s/<storage_id>/config.yaml — the local "settings file" distinct from the SHARED storage.yaml.
// Holds THIS computer's choices: keep .lfbridge/ + where, and which backing locations are ON + their
// absolute local paths. The `storage:` block is an identity mirror written by discovery (read-only).
const StorageBackingSchema = z
  .object({
    enabled: z.boolean().default(false),
    path: z.string().nullable().default(null),
  })
  .prefault({});
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
    .prefault({}),
  // The per-storage IPFS-pinning opt-in (pin_process.mdx §1 semantics, mirrored for storages). Default
  // OFF — a storage is known & visited every pass, but its mapped-dir bytes are added/pinned/fetched only
  // once the user opts in. Charter: never pin content without an explicit, user-confirmed action.
  pinned: z.boolean().default(false),
  lfbridge: z
    .object({
      enabled: z.boolean().default(true), // keep .lfbridge/ on this computer (default ON — §3)
      path: z.string().nullable().default(null), // null = default <root>/.lfbridge/
    })
    .prefault({}),
  backing: z
    .object({
      dedicated_repo: StorageBackingSchema,
      google_drive: StorageBackingSchema,
      dropbox: StorageBackingSchema,
    })
    .prefault({}),
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
  last_pin_at: iso.nullable().default(null),
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
    .prefault({}),
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
// not at the moment the 4-hour idle timer fires). Drives the > 48h "stale return" auto-pin.
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
// its per-storage backbone schedule, and the GRAFT — how the storage's machine-independent mapped-dir keys
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
    .prefault({}),
  schedule: z
    .object({
      enabled: z.boolean().default(true), // does this device pin this storage at all
      interval_minutes: z.number().default(15), // cadence (default matches the 15-min background pass)
      windows: z.array(DeviceScheduleWindowSchema).default([]), // optional specific times/windows
    })
    .prefault({}),
  // one entry per mapped source directory keyed in mapped_dirs.yaml (§4)
  graft: z.record(z.string(), DeviceGraftEntrySchema).default({}),
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
    .prefault({}),
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
    .prefault({}),
  tables: z.record(z.string(), z.unknown()).default({}),
  // The File System page's persisted view state (directories.mdx §1.3). A fresh user with no block
  // reads back the schema defaults (empty columns/selection, all filters ON) — never an error.
  file_system: FileSystemViewSchema.prefault({}),
  // Last 5 web sessions, newest first (sessions.mdx §4). At most one open (ended_at null), at index 0.
  sessions: z.array(SessionRecordSchema).default([]),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;
