// Per-user prefs (compression_visibility.mdx §1.1) — the small `features:` block of the per-user config.yaml
// (storage_local.mdx §4). Today it carries one flag: `features.compression`, the "Show compression features"
// setting, default OFF. It is PRESENTATION state: it decides what the browser shows, never what the backend
// computes, and it never gates access.
import type { UserPrefs } from "@lfb/shared";
import { UserFeaturesSchema } from "@lfb/shared";
import { getUserConfig, updateUserConfig } from "./user-config.service.js";

/** The user's prefs. A user with no config file yet reads back the schema defaults (all features off). */
export function loadUserPrefs(email: string): UserPrefs {
  return { features: getUserConfig(email).features };
}

/** Merge a patch onto the stored prefs and re-parse, so a partial body never defaults away another flag and
 *  a malformed one can never corrupt the config. Read-modify-write runs INSIDE updateUserConfig's lock. */
export async function saveUserPrefs(email: string, patch: { features?: Partial<UserPrefs["features"]> }): Promise<UserPrefs> {
  const updated = await updateUserConfig(email, (c) => {
    c.features = UserFeaturesSchema.parse({ ...c.features, ...(patch.features ?? {}) });
    return c;
  });
  return { features: updated.features };
}
