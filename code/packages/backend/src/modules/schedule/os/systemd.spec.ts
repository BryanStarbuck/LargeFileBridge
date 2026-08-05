// The Linux scheduler, tested where it can be: the two generated unit files and the readers
// `reconcileWorkerSchedules()` uses to notice drift.
//
// Same reasoning as schtasks.spec.ts. Every self-heal on this platform — a trigger script that moved, a node
// binary an upgrade deleted, a log directory that no longer exists, a cadence the user changed in settings —
// is "what we would install now" compared against "what is installed", and the second half is read back out
// of these files. If the render→read round-trip breaks, every drift check answers `null`, the reconcile pass
// becomes a permanent no-op, and nothing fails while the worker quietly stops being repaired.
import { describe, it, expect } from "vitest";
import type { InstallOpts } from "./installer.js";
import {
  renderService,
  renderTimer,
  execStartTokens,
  parseIntervalSeconds,
  parseLogPath,
  supported,
} from "./systemd.js";

const OPTS: InstallOpts = {
  label: "com.largefilebridge.device",
  worker: "device",
  intervalSeconds: 600,
  nodeBin: "/usr/bin/node",
  triggerScript: "/home/bryan/BGit/LargeFileBridge/code/deploy/launchd/run-worker.mjs",
  apiPort: 8787,
  logOut: "/home/bryan/T/_large_files_bridge/log.log",
  logErr: "/home/bryan/T/_large_files_bridge/error.err",
  enabled: true,
};

describe("the worker .service unit", () => {
  const service = renderService(OPTS);

  it("round-trips every field reconcile compares against", () => {
    expect(execStartTokens(service)[0]).toBe(OPTS.nodeBin);
    expect(execStartTokens(service)[1]).toBe(OPTS.triggerScript);
    expect(parseLogPath(service, "StandardOutput")).toBe(OPTS.logOut);
    expect(parseLogPath(service, "StandardError")).toBe(OPTS.logErr);
  });

  it("passes the trampoline its worker and port, in that order", () => {
    // run-worker.mjs reads argv[2] as the worker and argv[3] as the API port. Reversed, every cycle POSTs
    // /api/internal/run/8787 — a 404 the app answers happily while nothing ever syncs.
    expect(execStartTokens(service).slice(2)).toEqual(["device", "8787"]);
  });

  it("survives a path containing spaces", () => {
    // systemd splits ExecStart on whitespace unless a token is quoted, so an unquoted checkout under
    // `~/My Projects` becomes four arguments and the unit fails to start on every fire.
    const spaced = renderService({ ...OPTS, triggerScript: "/home/bryan/My Projects/run-worker.mjs" });
    expect(execStartTokens(spaced)[1]).toBe("/home/bryan/My Projects/run-worker.mjs");
    expect(execStartTokens(spaced).slice(2)).toEqual(["device", "8787"]);
  });

  it("sends stdout and stderr to the SAME files the macOS plist names", () => {
    // The LOG FORMAT CONTRACT in run-worker.mjs: stdout is log.log, stderr is the error.err fault trail.
    expect(service).toContain(`StandardOutput=append:${OPTS.logOut}`);
    expect(service).toContain(`StandardError=append:${OPTS.logErr}`);
  });

  it("runs once per fire rather than staying resident", () => {
    expect(service).toContain("Type=oneshot");
  });
});

describe("the worker .timer unit", () => {
  const timer = renderTimer(OPTS);

  it("declares the configured cadence where the drift reader looks for it", () => {
    expect(parseIntervalSeconds(timer)).toBe(600);
  });

  it("measures the first fire from ACTIVATION, never from boot", () => {
    // A boot-relative deadline is already in the past for a timer started mid-session, so systemd fires it
    // immediately — and every reconcile repair would kick a git cycle the moment it re-enabled the timer.
    expect(timer).toContain("OnActiveSec=600s");
    expect(timer).not.toContain("OnBootSec");
  });

  it("repeats from the last run, the way launchd's StartInterval does", () => {
    expect(timer).toContain("OnUnitActiveSec=600s");
  });

  it("never asks systemd for a sub-minute cadence", () => {
    expect(parseIntervalSeconds(renderTimer({ ...OPTS, intervalSeconds: 5 }))).toBe(60);
  });

  it("is enableable — without [Install] `systemctl enable` refuses it", () => {
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("fires the worker's own service unit", () => {
    expect(timer).toContain(`Unit=${OPTS.label}.service`);
  });

  it("reports an unreadable cadence as unknown rather than zero", () => {
    expect(parseIntervalSeconds("[Timer]\n")).toBeNull();
  });
});

describe("supported()", () => {
  it("is false anywhere that is not a systemd-booted Linux", () => {
    // The gate that keeps a non-systemd box on the no-op installer instead of accumulating unit files
    // nothing reads — and instead of a reconcile pass that WARNs on every tick forever.
    if (process.platform !== "linux") expect(supported()).toBe(false);
    else expect(typeof supported()).toBe("boolean");
  });
});
