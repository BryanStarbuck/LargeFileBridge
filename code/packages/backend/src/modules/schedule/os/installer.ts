// OS-agnostic scheduler installer interface (scan.mdx §3). Mac launchd is primary.
export interface SchedulerInstaller {
  install(opts: InstallOpts): Promise<void>;
  uninstall(label: string): Promise<void>;
  enable(label: string): Promise<void>;
  disable(label: string): Promise<void>;
  isInstalled(label: string): boolean;
  isEnabled(label: string): Promise<boolean>;
  /** The StartInterval (seconds) baked into the CURRENTLY-INSTALLED schedule, or null if not installed /
   *  not readable. Used to detect drift from the configured interval so a stale plist can be re-rendered. */
  installedIntervalSeconds(label: string): number | null;
}

export interface InstallOpts {
  label: string;
  worker: "scan" | "sync" | "device";
  intervalSeconds: number;
  nodeBin: string;
  triggerScript: string;
  apiPort: number;
  logOut: string;
  logErr: string;
}
