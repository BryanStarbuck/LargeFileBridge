// Windows Task Scheduler installer (scan.mdx §3 — "Windows | Task Scheduler | a scheduled task").
//
// WHY THIS FILE EXISTS. `installer()` returned the NO-OP installer on every platform but macOS, so on
// Windows nothing ever scheduled the workers: the every-10-minute `device` worker — the one that does the
// git pull / commit / push for every storage — was never fired by the OS at all. What covered it was the
// in-process watchdog, which by design only acts once a worker is OVERDUE (2× its interval + slack) and only
// while the web app is up. So a Windows machine committed and pushed roughly every 22 minutes at best, and
// NEVER while the app was closed. That is the "auto-commit and sync don't really work on Windows" report.
//
// THE SHAPE, and how it differs from launchd (os/launchd.ts):
//   • launchd takes `StandardOutPath`/`StandardErrorPath`; Task Scheduler has no such thing. So the task
//     runs a generated SHIM that redirects the trampoline's stdout/stderr to the same `log.log`/`error.err`
//     the macOS plist points at — the run-worker.mjs LOG FORMAT CONTRACT is preserved verbatim.
//   • The shim is a `.vbs` run under `wscript`, NOT a `.cmd` run directly, for one concrete reason: a task
//     whose action is a console program flashes a console window on the user's desktop EVERY time it fires.
//     144 flashes a day is a feature people switch off. `WScript.Shell.Run(cmd, 0, False)` starts it hidden.
//   • The shim is also where the node binary / trigger script / log paths / interval are READ BACK from, so
//     `reconcileWorkerSchedules()` gets the same drift detection and self-healing it has on macOS. They are
//     recorded as `' lfb-<key>: <value>` comment lines so parsing never depends on quoting.
//   • The task itself is registered from generated XML (`schtasks /Create /XML`) rather than the `/TR` +
//     `/SC` flags: `/TR` quoting is famously lossy, and XML is also language-neutral, which matters because
//     `schtasks /Query /FO LIST` prints a LOCALIZED status that we would otherwise have to parse to answer
//     `isEnabled()`.
//
// Everything written here is UTF-16LE with a BOM. That is a hard requirement for `schtasks /Create /XML`,
// and for the `.vbs` it is what lets a path under a non-ASCII user name (`C:\Users\José\…`) survive — a
// `.cmd` file would be read in the console code page and mangle it.
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { SchedulerInstaller, InstallOpts } from "./installer.js";
import { resolveStateDir } from "../../../config/state-dir.js";
import { log } from "../../../shared/logging.js";

const run = promisify(execFile);

/** Absolute paths to the system binaries we drive — immune to a thin background PATH (git-bin.ts).
 *  `path.win32` explicitly: these strings are baked into a `.vbs` and a task XML that only ever run on
 *  Windows, so they must not pick up the separator of whatever host happened to render them. */
function systemBin(name: string): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.win32.join(root, "System32", name);
}

/** Tasks live in their own Task Scheduler folder so the user can see (and delete) them as a group. */
function taskName(label: string): string {
  return `\\LargeFileBridge\\${label}`;
}

/** The generated launcher for one worker. Its existence IS "installed" — the plist-file equivalent. */
export function shimPath(label: string): string {
  return path.join(resolveStateDir(), "workers", `${label}.vbs`);
}

// ── the shim ────────────────────────────────────────────────────────────────

/**
 * The hidden launcher. It builds ONE command line and hands it to `cmd` so the `>>` redirections happen —
 * `WScript.Shell.Run` has no redirection of its own. `/d` skips AutoRun profile scripts (a user's registry
 * AutoRun must never be able to break a background worker) and `/s` makes cmd strip exactly the outer pair
 * of quotes and run the rest verbatim, which is the one quoting form that survives a quoted program path
 * AND quoted redirection targets in the same line.
 */
export function renderShim(o: InstallOpts): string {
  const cmdExe = systemBin("cmd.exe");
  // Paths cannot contain `"` on Windows, so the values below need no escaping — but they are also never
  // interpolated into a VBS string literal that a quote could close: `q` supplies every quote.
  return [
    `' Large File Bridge worker launcher — GENERATED, rewritten on every install. Do not edit.`,
    `' lfb-worker: ${o.worker}`,
    `' lfb-node: ${o.nodeBin}`,
    `' lfb-trigger: ${o.triggerScript}`,
    `' lfb-port: ${o.apiPort}`,
    `' lfb-log-out: ${o.logOut}`,
    `' lfb-log-err: ${o.logErr}`,
    `' lfb-interval: ${o.intervalSeconds}`,
    `Dim q, c`,
    `q = Chr(34)`,
    // Built in steps rather than one expression: VBScript caps a source line at 1023 characters, and four
    // absolute paths plus their quoting can reach that under a deep checkout.
    `c = q & "${o.nodeBin}" & q & " " & q & "${o.triggerScript}" & q & " ${o.worker} ${o.apiPort}"`,
    `c = c & " >>" & q & "${o.logOut}" & q & " 2>>" & q & "${o.logErr}" & q`,
    // The OUTER quote pair is what `/s` strips, leaving the inner command — including its own quoted
    // program path and quoted redirect targets — to run verbatim. Dropping it would make cmd strip the
    // node path's opening quote and the log path's closing one instead, and the worker would never run.
    `c = q & "${cmdExe}" & q & " /d /s /c " & q & c & q`,
    // 0 = hidden window, False = don't wait. The trampoline is a ~15s kick that returns as soon as the app
    // acknowledges; the real pass runs detached inside the app (run-job.ts).
    `CreateObject("WScript.Shell").Run c, 0, False`,
    ``,
  ].join("\r\n");
}

/** One `' lfb-<key>: <value>` marker out of a shim's text. Pure, so the render→read round-trip that all of
 *  reconcile's drift detection rides on can be tested without touching Task Scheduler. */
export function readShimField(body: string, key: string): string | null {
  const m = new RegExp(`^' lfb-${key}: (.*)$`, "m").exec(body);
  return m ? m[1].trim() : null;
}

/** One marker out of the INSTALLED shim, or null when it isn't there to read. */
function shimField(label: string, key: string): string | null {
  try {
    return readShimField(readUtf16(shimPath(label)), key);
  } catch {
    return null; // not installed / unreadable — nothing to compare against
  }
}

// ── the task XML ────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Local time as Task Scheduler wants a `StartBoundary`: `YYYY-MM-DDTHH:MM:SS`, no zone suffix. */
function localStartBoundary(now: Date = new Date()): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}` +
    `T${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`
  );
}

/** The repetition interval as an ISO-8601 duration. Never below one minute — Task Scheduler's floor. */
export function repetitionInterval(intervalSeconds: number): string {
  return `PT${Math.max(1, Math.round(intervalSeconds / 60))}M`;
}

/**
 * A TimeTrigger whose StartBoundary is NOW, repeating forever. Deliberately not a LogonTrigger: a
 * repetition pattern only starts when its trigger fires, so a logon-triggered task installed mid-session
 * would sit dead until the next logon — the user turns a worker on in the web app and nothing happens for a
 * day. A past/now StartBoundary starts the pattern immediately and Windows resumes it across reboots.
 *
 * `StartWhenAvailable` is the counterpart of launchd firing a missed `StartInterval`: a machine that was
 * asleep or off runs the cycle it missed as soon as it is back, instead of silently dropping it.
 *
 * `<Settings><Enabled>` carries the worker's ON/OFF state (`InstallOpts.enabled`). It has to: a task is LIVE
 * the moment `/Create` accepts it, unlike a plist, which does nothing until `launchctl bootstrap`. Hard-coding
 * `true` here made every install — including the routine drift re-render in `reconcileWorkerSchedules()` —
 * silently switch a worker the user had turned OFF back ON, and it resumed committing and pushing.
 */
export function renderTaskXml(o: InstallOpts): string {
  const wscript = systemBin("wscript.exe");
  const args = `//B //Nologo "${shimPath(o.label)}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Large File Bridge</Author>
    <Description>Large File Bridge background worker (${xmlEscape(o.worker)}) — runs every ${Math.max(1, Math.round(o.intervalSeconds / 60))} minute(s).</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${localStartBoundary()}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>${repetitionInterval(o.intervalSeconds)}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <Enabled>${o.enabled ? "true" : "false"}</Enabled>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <AllowHardTerminate>true</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wscript)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// ── UTF-16 file I/O (what schtasks and wscript both require) ────────────────

function writeUtf16(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(`\ufeff${body}`, "utf16le"));
}

/** Read a file that may be UTF-16LE (our own shims, schtasks output) or plain UTF-8. */
export function decodeMaybeUtf16(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8");
}

function readUtf16(file: string): string {
  return decodeMaybeUtf16(fs.readFileSync(file));
}

// ── schtasks ────────────────────────────────────────────────────────────────

/** Run schtasks, swallowing its failures the way launchd.ts swallows launchctl's (they are chatty and
 *  return non-zero for benign cases — "task does not exist" on a delete, most often). Every call mutates
 *  the registration, so the read cache below is dropped for that task. */
async function schtasks(label: string, ...args: string[]): Promise<void> {
  xmlCache.delete(label);
  try {
    await run(systemBin("schtasks.exe"), args, { windowsHide: true });
  } catch (e) {
    log.warn("schedule", `schtasks ${args.join(" ")}: ${(e as Error).message}`);
  }
}

// Every `/Query` is a process spawn, and the SYNC reader below blocks the event loop for its whole
// duration. One reconcile pass asks for the same task's XML twice (interval drift, then enabled state) and
// a jobs-page render asks for all three workers — so the answer is memoized for a few seconds and dropped
// the moment we change the registration ourselves. Short enough that a change made in the Task Scheduler
// UI is still noticed on the next reconcile.
const XML_CACHE_MS = 5_000;
const xmlCache = new Map<string, { at: number; xml: string | null }>();

function cachedXml(label: string): string | null | undefined {
  const hit = xmlCache.get(label);
  if (hit && Date.now() - hit.at < XML_CACHE_MS) return hit.xml;
  return undefined; // never queried, or gone stale
}

// `/XML` with no ONE|ALL argument: `ONE` is documented as "all tasks in one file", and combined with `/TN`
// its behaviour is inconsistent across Windows builds — the last thing this reader wants is another task's
// `<Repetition>`. With `/TN` given, plain `/XML` is exactly this task's registration.
const QUERY_ARGS = (label: string): string[] => ["/Query", "/TN", taskName(label), "/XML"];

/** The task's registration XML as Windows currently holds it, or null when there is no such task. */
function queryTaskXml(label: string): string | null {
  const hit = cachedXml(label);
  if (hit !== undefined) return hit;
  let xml: string | null;
  try {
    const out = execFileSync(systemBin("schtasks.exe"), QUERY_ARGS(label), {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    xml = decodeMaybeUtf16(out);
  } catch {
    xml = null; // no such task (or schtasks itself is unavailable)
  }
  xmlCache.set(label, { at: Date.now(), xml });
  return xml;
}

/** The same read without blocking the event loop — for the async members of the interface. */
async function queryTaskXmlAsync(label: string): Promise<string | null> {
  const hit = cachedXml(label);
  if (hit !== undefined) return hit;
  let xml: string | null;
  try {
    const { stdout } = await run(systemBin("schtasks.exe"), QUERY_ARGS(label), {
      windowsHide: true,
      timeout: 20_000,
      encoding: "buffer",
    });
    xml = decodeMaybeUtf16(stdout as Buffer);
  } catch {
    xml = null;
  }
  xmlCache.set(label, { at: Date.now(), xml });
  return xml;
}

/** `<Enabled>` from the task's `<Settings>` block — the language-neutral answer `/FO LIST` cannot give. */
export function settingsEnabled(xml: string): boolean {
  const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(xml);
  if (!settings) return false;
  const m = /<Enabled>\s*(true|false)\s*<\/Enabled>/i.exec(settings[1]);
  return m ? m[1].toLowerCase() === "true" : true; // absent means enabled, per the task schema default
}

/** The repetition interval Windows currently holds, in seconds, or null when it isn't expressed in minutes. */
export function parseRepetitionSeconds(xml: string): number | null {
  const m = /<Repetition>[\s\S]*?<Interval>\s*PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?\s*<\/Interval>/i.exec(xml);
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds > 0 ? seconds : null;
}

/** Remove the launcher, so `isInstalled()` never answers yes for a worker Task Scheduler does not have. */
function dropShim(label: string): void {
  try {
    fs.unlinkSync(shimPath(label));
  } catch {
    /* nothing to undo */
  }
}

export const schtasksInstaller: SchedulerInstaller = {
  async install(o) {
    // The shim first: a task registered against a launcher that doesn't exist yet would fire into nothing.
    try {
      writeUtf16(shimPath(o.label), renderShim(o));
    } catch (e) {
      log.error("schedule", `Failed to write the worker launcher ${shimPath(o.label)}: ${(e as Error).message}`);
      throw e;
    }
    const xmlFile = path.join(resolveStateDir(), "workers", `${o.label}.task.xml`);
    try {
      writeUtf16(xmlFile, renderTaskXml(o));
    } catch (e) {
      // Take the shim back down with it. `isInstalled()` reads the SHIM, so leaving it behind after a
      // failure that means NOTHING GOT REGISTERED is the same lie the verification below exists to catch:
      // the jobs page would say "installed" over a Task Scheduler that has never heard of this worker.
      dropShim(o.label);
      log.error("schedule", `Failed to write the scheduled-task definition ${xmlFile}: ${(e as Error).message}`);
      throw e;
    }
    // `/F` overwrites an existing registration — this is also the re-render path (reconcileWorkerSchedules).
    await schtasks(o.label, "/Create", "/TN", taskName(o.label), "/XML", xmlFile, "/F");
    // VERIFY, because `schtasks` failures are swallowed (they are chatty and benign more often than not) and
    // `isInstalled()` answers from the SHIM FILE, which was just written. Without this check a rejected
    // registration — a malformed XML, a policy-locked Task Scheduler — leaves config saying "installed",
    // the jobs page saying "installed", and NOTHING scheduled: the precise silent nothing this module was
    // written to end. Drop the shim so `isInstalled()` stays honest and the next reconcile retries.
    //
    // The ASYNC reader: `install()` runs inside the `POST /api/jobs/:kind/:action` request, and the sync one
    // below blocks the event loop for as long as schtasks takes to answer — up to its 20s timeout, with the
    // whole web app frozen behind it.
    if ((await queryTaskXmlAsync(o.label)) === null) {
      dropShim(o.label);
      const msg = `Task Scheduler did not register ${taskName(o.label)} — the ${o.worker} worker is NOT scheduled (definition kept at ${xmlFile})`;
      log.error("schedule", msg);
      throw new Error(msg);
    }
    log.info(
      "schedule",
      `Installed scheduled task ${taskName(o.label)} → ${shimPath(o.label)} (${o.enabled ? "enabled" : "disabled"})`,
    );
  },

  async uninstall(label) {
    await schtasks(label, "/Delete", "/TN", taskName(label), "/F");
    for (const f of [shimPath(label), path.join(resolveStateDir(), "workers", `${label}.task.xml`)]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
  },

  async enable(label) {
    await schtasks(label, "/Change", "/TN", taskName(label), "/ENABLE");
  },

  async disable(label) {
    await schtasks(label, "/Change", "/TN", taskName(label), "/DISABLE");
  },

  // "Installed" is the launcher on disk — the direct analogue of launchd's plist file, and a cheap fs
  // check rather than a process spawn on every jobs-page render. Whether Windows actually still HAS the
  // task is `isEnabled()`'s question, and a yes/no mismatch there is what drives the self-heal.
  isInstalled(label) {
    try {
      return fs.existsSync(shimPath(label));
    } catch {
      return false;
    }
  },

  async isEnabled(label) {
    const xml = await queryTaskXmlAsync(label);
    return xml !== null && settingsEnabled(xml);
  },

  installedIntervalSeconds(label) {
    // Read the REGISTERED trigger, not our shim marker: this is the one field a user can change behind our
    // back in the Task Scheduler UI, and drifting from the configured cadence is exactly what reconcile is
    // looking for. Falls back to the shim when the task can't be queried.
    const xml = queryTaskXml(label);
    const fromTask = xml ? parseRepetitionSeconds(xml) : null;
    if (fromTask !== null) return fromTask;
    const marker = shimField(label, "interval");
    const n = marker ? Number(marker) : NaN;
    return Number.isFinite(n) ? n : null;
  },

  installedTriggerScript(label) {
    return shimField(label, "trigger");
  },

  installedNodeBin(label) {
    return shimField(label, "node");
  },

  installedLogPaths(label) {
    const out = shimField(label, "log-out");
    const err = shimField(label, "log-err");
    return out && err ? { out, err } : null;
  },
};
