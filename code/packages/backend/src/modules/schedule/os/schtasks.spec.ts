// The Windows scheduler, tested where it can be: the two generated artifacts and the readers that
// `reconcileWorkerSchedules()` uses to notice drift.
//
// WHY THESE ARE THE TESTS THAT MATTER. The whole macOS self-healing story — a worker whose plist points at
// a moved run-worker.mjs, a node binary an upgrade deleted, a log directory that no longer exists — is
// implemented by comparing "what we would install now" against "what is installed". On Windows those
// answers are read back out of the generated shim, so if the render→read round-trip breaks, every drift
// check silently answers `null` and the reconcile pass becomes a no-op FOREVER, without failing anything.
// That is the same silent-death class the launchd path has been bitten by twice.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstallOpts } from "./installer.js";
import {
  renderShim,
  renderTaskXml,
  readShimField,
  repetitionInterval,
  parseRepetitionSeconds,
  settingsEnabled,
  decodeMaybeUtf16,
  shimPath,
  schtasksInstaller,
} from "./schtasks.js";

const OPTS: InstallOpts = {
  label: "com.largefilebridge.device",
  worker: "device",
  intervalSeconds: 600,
  nodeBin: "C:\\Program Files\\nodejs\\node.exe",
  triggerScript: "C:\\Users\\bryan\\BGit\\LargeFileBridge\\code\\deploy\\launchd\\run-worker.mjs",
  apiPort: 8787,
  logOut: "C:\\Users\\bryan\\T\\_large_files_bridge\\log.log",
  logErr: "C:\\Users\\bryan\\T\\_large_files_bridge\\error.err",
  enabled: true,
};

describe("the worker shim", () => {
  const shim = renderShim(OPTS);

  it("round-trips every field reconcile compares against", () => {
    expect(readShimField(shim, "node")).toBe(OPTS.nodeBin);
    expect(readShimField(shim, "trigger")).toBe(OPTS.triggerScript);
    expect(readShimField(shim, "log-out")).toBe(OPTS.logOut);
    expect(readShimField(shim, "log-err")).toBe(OPTS.logErr);
    expect(readShimField(shim, "interval")).toBe("600");
    expect(readShimField(shim, "worker")).toBe("device");
  });

  it("reads a field as null when it isn't there, rather than guessing", () => {
    expect(readShimField(shim, "nonesuch")).toBeNull();
  });

  it("passes the trampoline its worker and port, in that order", () => {
    // run-worker.mjs reads `process.argv[2]` as the worker and `[3]` as the API port. Getting these
    // backwards would POST /api/internal/run/8787 every cycle — a 404 the app answers happily.
    expect(shim).toContain(` device ${OPTS.apiPort}"`);
  });

  it("keeps every generated line inside VBScript's 1023-character limit", () => {
    for (const line of shim.split("\r\n")) expect(line.length).toBeLessThan(1023);
  });

  it("writes Windows separators regardless of the host that rendered it", () => {
    // Caught in review: `path.join` follows the RENDERING host, so building the shim anywhere but Windows
    // emitted `C:\Windows/System32/cmd.exe`. Harmless in a spec, wrong in a file only Windows runs.
    expect(shim).toContain("\\System32\\cmd.exe");
    expect(shim).not.toMatch(/System32\//);
  });

  it("redirects stdout and stderr to the SAME files the macOS plist names", () => {
    // The LOG FORMAT CONTRACT in run-worker.mjs: stdout is log.log, stderr is the error.err fault trail.
    expect(shim).toContain(`>>" & q & "${OPTS.logOut}"`);
    expect(shim).toContain(`2>>" & q & "${OPTS.logErr}"`);
  });

  it("runs the worker with NO console window", () => {
    // `Run(cmd, 0, False)` — 0 is hidden. A visible window here is 144 console flashes a day on the
    // user's desktop, which is a feature people turn off rather than tolerate.
    expect(shim).toContain("CreateObject(\"WScript.Shell\").Run c, 0, False");
  });

  it("quotes the program and both redirection targets through cmd's /s form", () => {
    // `cmd /d /s /c "…"` strips exactly the outer quote pair and runs the rest verbatim — the only form
    // that survives a quoted program path AND quoted redirect targets on one line. `/d` skips AutoRun.
    expect(shim).toContain("/d /s /c");
    expect(shim).toContain("q = Chr(34)");
    // The wrapping pair `/s` consumes. Without it cmd strips the node path's opening quote and the log
    // path's closing one, and a worker under any path containing a space never starts.
    expect(shim).toContain(`/d /s /c " & q & c & q`);
  });
});

describe("the task XML", () => {
  const xml = renderTaskXml(OPTS);

  it("declares the configured cadence as a repetition Windows will honour", () => {
    expect(repetitionInterval(600)).toBe("PT10M");
    expect(parseRepetitionSeconds(xml)).toBe(600);
  });

  it("never asks Task Scheduler for a sub-minute interval it cannot schedule", () => {
    expect(repetitionInterval(30)).toBe("PT1M");
    expect(repetitionInterval(0)).toBe("PT1M");
  });

  it("starts repeating immediately instead of waiting for the next logon", () => {
    // A LogonTrigger's repetition pattern only begins when the trigger fires, so a worker installed
    // mid-session would sit dead until the user next logged in. A TimeTrigger bounded at NOW starts now.
    expect(xml).toContain("<TimeTrigger>");
    expect(xml).not.toContain("<LogonTrigger>");
    expect(xml).toMatch(/<StartBoundary>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}<\/StartBoundary>/);
  });

  it("repeats indefinitely — no Duration means no expiry", () => {
    expect(xml).not.toContain("<Duration>");
    expect(xml).not.toContain("<EndBoundary>");
  });

  it("runs a cycle the machine missed while it was asleep or off", () => {
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
  });

  it("does not skip cycles on a laptop running on battery", () => {
    // The default is `true` for both, which would stop a laptop syncing the moment it is unplugged.
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
  });

  it("coalesces rather than stacking overlapping runs", () => {
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  });

  it("launches the shim through wscript, not the trampoline directly", () => {
    expect(xml).toMatch(/<Command>[^<]*wscript\.exe<\/Command>/);
    expect(xml).toContain("com.largefilebridge.device.vbs");
  });

  it("wraps the principal in <Principals>, which is what Task Scheduler will actually accept", () => {
    // The XSD's `Task` element has a `Principals` child, not a `Principal` one. A bare `<Principal>` under
    // `<Task>` is rejected outright — and `schtasks()` swallows its own failures, so the rejection showed up
    // as nothing at all: the shim was written, `isInstalled()` (which reads the shim) said yes, config
    // recorded "installed", and NO TASK EXISTED. The whole Windows fix silently did nothing.
    expect(xml).toContain("<Principals>");
    expect(xml).toContain("</Principals>");
    expect(xml).toMatch(/<Principals>\s*<Principal id="Author">/);
    expect(xml).toMatch(/<\/Principal>\s*<\/Principals>/);
    // The Actions element names that principal by id; a dangling reference is the other way to be rejected.
    expect(xml).toContain('<Actions Context="Author">');
  });

  it("registers the task in the state config says it should be in, not always ON", () => {
    // A task is LIVE the moment /Create accepts it — unlike a plist, which needs `launchctl bootstrap`. With
    // <Enabled> hard-coded true, every install re-enabled a worker the user had switched OFF: at boot, at
    // each watchdog repair, at each drift re-render. For the `device` worker that means this computer
    // silently resumed committing and pushing every 10 minutes with the switch showing off.
    expect(settingsEnabled(renderTaskXml({ ...OPTS, enabled: true }))).toBe(true);
    expect(settingsEnabled(renderTaskXml({ ...OPTS, enabled: false }))).toBe(false);
  });

  it("keeps the TRIGGER enabled when the task is off, so re-enabling needs no re-render", () => {
    // Off is expressed once, in <Settings> — the same place `isEnabled()` reads and `/Change /ENABLE` writes.
    const off = renderTaskXml({ ...OPTS, enabled: false });
    expect(/<TimeTrigger>[\s\S]*?<Enabled>true<\/Enabled>[\s\S]*?<\/TimeTrigger>/.test(off)).toBe(true);
  });

  it("escapes XML metacharacters in the paths it embeds", () => {
    const risky = renderTaskXml({ ...OPTS, worker: "device", label: "a&b" });
    expect(risky).not.toMatch(/<Description>[^<]*[^&;]&[^a-z]/);
    expect(risky).toContain("&amp;");
  });
});

describe("reading Windows' own answers", () => {
  it("treats a task with no explicit Enabled as enabled, per the task schema", () => {
    expect(settingsEnabled("<Settings><Hidden>false</Hidden></Settings>")).toBe(true);
  });

  it("reads Enabled out of Settings, not out of a trigger", () => {
    // A DISABLED task whose trigger element still says `<Enabled>true</Enabled>` is the exact shape that
    // would make `isEnabled()` lie, and a lying isEnabled() means reconcile never re-bootstraps the job.
    const xml =
      "<Task><Triggers><TimeTrigger><Enabled>true</Enabled></TimeTrigger></Triggers>" +
      "<Settings><Enabled>false</Enabled></Settings></Task>";
    expect(settingsEnabled(xml)).toBe(false);
  });

  it("answers false when there is no task at all", () => {
    expect(settingsEnabled("")).toBe(false);
  });

  it("decodes the UTF-16 schtasks actually emits, and plain UTF-8 too", () => {
    // `schtasks /Query /XML` writes UTF-16LE with a BOM; reading it as utf8 yields NUL-separated mojibake
    // that every regex above would silently fail to match.
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<Task/>", "utf16le")]);
    expect(decodeMaybeUtf16(utf16)).toBe("<Task/>");
    expect(decodeMaybeUtf16(Buffer.from("<Task/>", "utf8"))).toBe("<Task/>");
  });

  it("reports an interval it cannot express in seconds as unknown rather than zero", () => {
    expect(parseRepetitionSeconds("<Task/>")).toBeNull();
    expect(parseRepetitionSeconds("<Repetition><Interval>PT1H</Interval>")).toBe(3600);
  });
});

// `isInstalled()` answers from the SHIM FILE, so the shim is the app's ONLY evidence that a worker is
// scheduled — the jobs page reads it, and `reconcileWorkerSchedules()` decides from it whether to reinstall.
// A shim left behind after an install that registered nothing therefore does not merely mislead: it tells
// reconcile "already handled" forever, and the worker never runs on that computer again. Every failure path
// out of `install()` has to take the shim with it.
describe("install() never claims a worker Task Scheduler does not have", () => {
  let stateDir = "";
  let priorState: string | undefined;
  let priorRoot: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-schtasks-"));
    priorState = process.env.LFB_STATE_DIR;
    priorRoot = process.env.SystemRoot;
    process.env.LFB_STATE_DIR = stateDir;
    // Point the system-binary lookup at a directory with no schtasks.exe, so the registration fails the same
    // way a policy-locked Task Scheduler does — and, on a real Windows box, WITHOUT creating a live task.
    process.env.SystemRoot = path.join(stateDir, "nowhere");
  });

  afterEach(() => {
    if (priorState === undefined) delete process.env.LFB_STATE_DIR;
    else process.env.LFB_STATE_DIR = priorState;
    if (priorRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = priorRoot;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("removes the shim when the registration does not take", async () => {
    await expect(schtasksInstaller.install(OPTS)).rejects.toThrow(/NOT scheduled/);
    expect(schtasksInstaller.isInstalled(OPTS.label)).toBe(false);
    expect(fs.existsSync(shimPath(OPTS.label))).toBe(false);
  });

  it("removes the shim when the task definition itself cannot be written", async () => {
    // The shim is written FIRST (a task must never point at a launcher that doesn't exist yet), so a failure
    // on the definition is the one window where a shim can survive an install that registered nothing.
    const xmlFile = path.join(stateDir, "workers", `${OPTS.label}.task.xml`);
    fs.mkdirSync(xmlFile, { recursive: true }); // a directory where the definition must go — the write fails
    await expect(schtasksInstaller.install(OPTS)).rejects.toThrow();
    expect(schtasksInstaller.isInstalled(OPTS.label)).toBe(false);
  });
});
