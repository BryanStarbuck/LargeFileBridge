// OS-agnostic scheduler installer interface (scan.mdx §3). Mac launchd is primary.
export interface SchedulerInstaller {
  install(opts: InstallOpts): Promise<void>;
  uninstall(label: string): Promise<void>;
  enable(label: string): Promise<void>;
  disable(label: string): Promise<void>;
  isInstalled(label: string): boolean;
  isEnabled(label: string): Promise<boolean>;
}

export interface InstallOpts {
  label: string;
  worker: "scan" | "sync";
  intervalSeconds: number;
  nodeBin: string;
  triggerScript: string;
  apiPort: number;
  logOut: string;
  logErr: string;
}
