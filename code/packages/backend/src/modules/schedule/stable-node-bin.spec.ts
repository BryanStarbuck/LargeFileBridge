// A worker plist must not bake in a VERSION-PINNED interpreter.
//
// The failure this guards: `process.execPath` under Homebrew is `/opt/homebrew/Cellar/node/<version>/bin/node`.
// `brew upgrade node` deletes that directory, so every installed plist is left naming a binary that no longer
// exists — and launchd fails to spawn the job on every fire, SILENTLY, because a job that never starts writes
// nothing to our logs and never reaches `stampRun`. It is the same class as the run-worker.mjs path bug, one
// argument to the left, and it was live on the reference machine: the `scan` plist named node 26.4.0 while the
// installed runtime was 26.5.0.
//
// The fix prefers a stable symlink, but ONLY one that currently resolves to the binary we are running — so a
// worker can never be pointed at some other node that happens to be on the box.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { stableNodeBin } from "./schedule.service.js";

describe("stableNodeBin — survives a runtime upgrade", () => {
  it("never returns a path that does not exist", () => {
    expect(fs.existsSync(stableNodeBin())).toBe(true);
  });

  it("resolves to the SAME binary we are actually running", () => {
    expect(fs.realpathSync(stableNodeBin())).toBe(fs.realpathSync(process.execPath));
  });

  it("prefers a version-independent path when one aliases this runtime", () => {
    const chosen = stableNodeBin();
    // On any machine whose node came from a package manager, one of the stable aliases resolves to our
    // binary; that is the whole point. Assert we took it rather than the version-pinned original.
    const stableAlias = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].find((p) => {
      try {
        return fs.realpathSync(p) === fs.realpathSync(process.execPath);
      } catch {
        return false;
      }
    });
    if (!stableAlias) return; // unusual layout (nvm, bare tarball) — falling back to execPath is correct
    expect(chosen).toBe(stableAlias);
    expect(chosen).not.toMatch(/\/Cellar\/node\/\d/); // the version-pinned shape that disappears on upgrade
  });

  it("falls back to the given path unchanged when it cannot be resolved", () => {
    const bogus = "/nonexistent/path/to/node";
    expect(stableNodeBin(bogus)).toBe(bogus);
  });
});
