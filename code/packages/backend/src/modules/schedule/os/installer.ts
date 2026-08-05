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
  /** The worker trampoline script path baked into the CURRENTLY-INSTALLED schedule, or null if not installed /
   *  not readable. Used to detect a drifted/broken path (e.g. after a code move) so the plist self-heals. */
  installedTriggerScript(label: string): string | null;
  /** The node binary baked into the CURRENTLY-INSTALLED schedule, or null if not installed / not readable.
   *  A version-pinned interpreter path disappears the moment the runtime is upgraded, and the OS job then
   *  dies on every fire with nothing in our logs — so this is compared against what we would install now. */
  installedNodeBin(label: string): string | null;
  /** The stdout/stderr paths baked into the CURRENTLY-INSTALLED schedule, or null if not installed /
   *  not readable. launchd refuses to spawn a job whose log file it cannot open, so a plist left pointing at
   *  a directory that has since been removed is a dead worker. */
  installedLogPaths(label: string): { out: string; err: string } | null;
}

export interface InstallOpts {
  label: string;
  worker: "scan" | "pin" | "device";
  intervalSeconds: number;
  nodeBin: string;
  triggerScript: string;
  apiPort: number;
  logOut: string;
  logErr: string;
  /** Whether config says this worker should be FIRING (`<process>_process.enabled`). Installing is not
   *  turning on — the two are separate choices (charter, scan.mdx §7) — and on the schedulers whose unit is
   *  an inert FILE (launchd's plist, a systemd .timer) that separation is free, so they ignore this field.
   *  A Windows scheduled task is LIVE the moment `schtasks /Create` accepts it, so the installer has to be
   *  told the desired state: rendering `<Enabled>true</Enabled>` unconditionally turned a worker the user
   *  had switched off back on — on every boot, every watchdog repair, every drift re-render — and it then
   *  quietly resumed committing and pushing from that computer. */
  enabled: boolean;
}
