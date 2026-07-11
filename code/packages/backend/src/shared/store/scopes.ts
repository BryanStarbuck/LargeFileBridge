// Path helpers for the three store scopes (storage.mdx §2, §15): app / user / pin-unit.
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

// ── Pin-unit scope (computer-wide, OUTSIDE users/) ──────────────────────────
export const computerUnitDir = () => path.join(root(), "pin", "computer");
export const repoUnitDir = (folder: string) => path.join(root(), "pin", "r", folder);
export const reposRoot = () => path.join(root(), "pin", "r");

// Per-storage machine-local settings unit (storage_settings.mdx §5): pin/s/<storage_id>/config.yaml.
export const storageUnitDir = (storageId: string) => path.join(root(), "pin", "s", storageId);
export const storagesRoot = () => path.join(root(), "pin", "s");

// Per-community subscription unit (communities.mdx §8): pin/c/<community_id>/{config,manifest,status}.yaml.
// A community is mechanically a repo-shaped pin unit whose bytes are someone else's.
export const communityUnitDir = (communityId: string) => path.join(root(), "pin", "c", communityId);
export const communitiesRoot = () => path.join(root(), "pin", "c");

export const unitConfigPath = (dir: string) => path.join(dir, "config.yaml");
export const unitManifestPath = (dir: string) => path.join(dir, "manifest.yaml");
export const unitStatusPath = (dir: string) => path.join(dir, "status.yaml");

export { repoFolderKey };
