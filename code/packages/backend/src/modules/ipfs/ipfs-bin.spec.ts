// The `ipfs` binary must be found from a THIN PATH — the same hardening git already had (git-bin.ts).
//
// The failure this guards: every `ipfs` invocation was a bare name (`spawn("ipfs", ["daemon", …])`,
// `ipfs init`, `ipfs version --number`) plus a `command -v ipfs` probe run through `/bin/bash`. All four
// resolve through the CALLER's PATH, and the contexts this product is built to run in are exactly the ones
// with a thin PATH: a launchd worker with no `EnvironmentVariables` block, a Windows scheduled task, a
// systemd user unit. There the daemon start dies with `spawn ipfs ENOENT` and the install probe answers
// "IPFS isn't installed on this computer" for a machine that has it — so IPFS never comes up and the UI
// blames the user. On Windows it was worse than a PATH problem: the file is `ipfs.exe` and `/bin/bash` does
// not exist at all, so the probe threw on every single call.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stableIpfsBin, ipfsBinResolved, resetIpfsBinCache } from "./ipfs-bin.js";

const isWindows = process.platform === "win32";
const BIN = isWindows ? "ipfs.exe" : "ipfs";

const dirs: string[] = [];
const originalPath = process.env.PATH;

function tempBinDir(withBinary: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-ipfsbin-"));
  dirs.push(dir);
  if (withBinary) {
    const file = path.join(dir, BIN);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

beforeEach(() => resetIpfsBinCache());
afterEach(() => {
  process.env.PATH = originalPath;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  resetIpfsBinCache();
});

describe("stableIpfsBin", () => {
  it("resolves to an ABSOLUTE path when the binary is on PATH", () => {
    const dir = tempBinDir(true);
    process.env.PATH = dir;
    const bin = stableIpfsBin();
    expect(path.isAbsolute(bin)).toBe(true);
    expect(bin).toBe(path.join(dir, BIN));
    expect(ipfsBinResolved()).toBe(true);
  });

  it("looks for the platform's real FILENAME — `ipfs.exe` on Windows, `ipfs` elsewhere", () => {
    const dir = tempBinDir(true);
    process.env.PATH = dir;
    expect(path.basename(stableIpfsBin())).toBe(BIN);
  });

  it("falls back to the bare name (and reports NOT resolved) when nothing is found", () => {
    // A thin PATH with no ipfs anywhere in it. The standard install dirs may still hold one on a dev box,
    // so only assert the honest contract: whatever comes back, `ipfsBinResolved()` agrees with it.
    process.env.PATH = tempBinDir(false);
    const bin = stableIpfsBin();
    expect(ipfsBinResolved()).toBe(path.isAbsolute(bin));
    if (!path.isAbsolute(bin)) expect(bin).toBe("ipfs"); // let spawn report its own error, as before
  });

  it("memoizes, so the per-call probe is paid once", () => {
    const dir = tempBinDir(true);
    process.env.PATH = dir;
    const first = stableIpfsBin();
    process.env.PATH = tempBinDir(false); // the cache must win over a PATH that no longer has it
    expect(stableIpfsBin()).toBe(first);
  });

  it("re-probes after resetIpfsBinCache — the binary an install just created must become visible", () => {
    // Exactly the install job's sequence: probe (absent) → package manager runs → probe again. Without the
    // reset, a memoized "not found" makes the install report itself as failed on a machine where it worked.
    process.env.PATH = tempBinDir(false);
    const before = stableIpfsBin(); // may resolve to a real system install; only the CACHING is under test
    const installed = tempBinDir(true);
    process.env.PATH = installed; // PATH is searched first, so this must win once the cache is dropped
    expect(stableIpfsBin()).toBe(before); // still cached — this is why the reset exists
    resetIpfsBinCache();
    expect(stableIpfsBin()).toBe(path.join(installed, BIN));
  });
});
