// Path helpers for the three store scopes (storage.mdx §2, §15): app / user / sync-unit.
import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import { emailKey, repoFolderKey } from "./sanitize.js";

const root = () => resolveStateDir();

// ── App scope ───────────────────────────────────────────────────────────────
export const appConfigPath = () => path.join(root(), "config.yaml");
export const peersPath = () => path.join(root(), "peers.yaml");
export const authSecretPath = () => path.join(root(), ".auth_session_secret");

// ── User scope (created lazily) ─────────────────────────────────────────────
export const userDir = (email: string) => path.join(root(), "users", emailKey(email));
export const userConfigPath = (email: string) => path.join(userDir(email), "config.yaml");
export const userSessionsDir = (email: string) => path.join(userDir(email), "sessions");

// ── Sync-unit scope (computer-wide, OUTSIDE users/) ─────────────────────────
export const computerUnitDir = () => path.join(root(), "sync", "computer");
export const repoUnitDir = (folder: string) => path.join(root(), "sync", "r", folder);
export const reposRoot = () => path.join(root(), "sync", "r");

// Per-storage machine-local settings unit (storage_settings.mdx §5): sync/s/<storage_id>/config.yaml.
export const storageUnitDir = (storageId: string) => path.join(root(), "sync", "s", storageId);
export const storagesRoot = () => path.join(root(), "sync", "s");

export const unitConfigPath = (dir: string) => path.join(dir, "config.yaml");
export const unitManifestPath = (dir: string) => path.join(dir, "manifest.yaml");
export const unitStatusPath = (dir: string) => path.join(dir, "status.yaml");

export { repoFolderKey };
