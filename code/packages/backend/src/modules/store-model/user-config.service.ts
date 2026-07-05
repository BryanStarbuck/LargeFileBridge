// Typed accessor for the per-logged-in-user config.yaml (storage.mdx §4). Personal, cosmetic state:
// UI prefs, remembered table views, and the web-session history (sessions.mdx §4). Created lazily on
// the first write; a user with no folder yet reads back schema defaults (never an error, never a write).
import { UserConfigSchema, type UserConfig } from "@lfb/shared";
import { readYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { userConfigPath } from "../../shared/store/scopes.js";

export function getUserConfig(email: string): UserConfig {
  return readYaml(userConfigPath(email), UserConfigSchema);
}

export async function updateUserConfig(
  email: string,
  mutate: (c: UserConfig) => UserConfig,
): Promise<UserConfig> {
  return updateYaml(userConfigPath(email), UserConfigSchema, mutate);
}
