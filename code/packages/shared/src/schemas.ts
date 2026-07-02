// Zod schemas for the on-disk YAML the store reads/writes (storage.mdx §14 inventory).
// Kept in @lfb/shared so backend validation and any frontend type-narrowing agree.
import { z } from "zod";

const iso = z.string();

// ── app-level config.yaml (storage.mdx §3 + settings.mdx §1.3) ──────────────
export const AppConfigSchema = z.object({
  schema_version: z.number().default(1),
  updated_at: iso.optional(),
  server: z
    .object({
      frontend_port: z.number().default(8080),
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
  scan_process: z
    .object({
      installed: z.boolean().default(false),
      enabled: z.boolean().default(false),
      interval_hours: z.number().default(4),
      label: z.string().default("com.largefilebridge.scan"),
      last_run_at: iso.nullable().default(null),
      last_run_ok: z.boolean().nullable().default(null),
    })
    .default({}),
  access: z
    .object({
      allowed_emails: z.array(z.string()).default([]),
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
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

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
  unit: z.enum(["repo", "computer"]).default("repo"),
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
});
export type UserConfig = z.infer<typeof UserConfigSchema>;
