// Typed accessor for the app-level, computer-wide config.yaml (storage.mdx §3, settings.mdx).
import { AppConfigSchema, type AppConfig } from "@lfb/shared";
import { readYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { appConfigPath } from "../../shared/store/scopes.js";

export function getAppConfig(): AppConfig {
  const cfg = readYaml(appConfigPath(), AppConfigSchema);
  // First-run seeding of sensible scanner roots so the app has something to show.
  if (cfg.scanner.roots.length === 0) {
    cfg.scanner.roots = defaultRoots();
  }
  return cfg;
}

export async function updateAppConfig(mutate: (c: AppConfig) => AppConfig): Promise<AppConfig> {
  return updateYaml(appConfigPath(), AppConfigSchema, (c) => {
    if (c.scanner.roots.length === 0) c.scanner.roots = defaultRoots();
    return mutate(c);
  });
}

function defaultRoots(): string[] {
  const home = process.env.HOME || "~";
  return [`${home}/BGit`, `${home}/Documents`];
}
