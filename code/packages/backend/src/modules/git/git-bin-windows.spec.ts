// THE WINDOWS GIT BINARY (git_backbone.mdx §5.1). On 2026-08-06 a Windows machine logged, on every single
// device cycle and with escalating backoff:
//
//   [pin] device registration for storage c140b1a11690 failed: Invalid value supplied for custom binary,
//   restricted characters must be removed or supply the unsafe.allowUnsafeCustomBinary option
//
// `simple-git` validates the custom `binary` it is handed against /^([a-z]:)?([a-z0-9/.\\_~-]+)$/i and
// throws out of its FACTORY when the value does not match. Git for Windows installs at
// `C:\Program Files\Git\cmd\git.exe` — a space — so `openRepo()` threw before running a command, and with
// it every pull, commit, push and device registration on the platform. Nothing was wrong with the path:
// the direct `execFileSync(stableGitBin(), …)` callers used it all along without complaint.
//
// The two halves pinned here:
//   • the PREDICATE agrees with simple-git's own rule, so we never hand over a value it will reject;
//   • the FALLBACK still resolves to the same binary — the directory goes to the FRONT of the child's
//     PATH, under the key Windows actually uses (`Path`), so a bare `git` finds the file we picked.
import path from "node:path";
import { describe, it, expect } from "vitest";
import { isSimpleGitSafeBinary, stableGitBin, withGitOnPath } from "./git-bin.js";

// simple-git's own test, copied from `custom-binary.plugin.ts` (`isBadArgument`). If a future upgrade
// changes it, THIS is the line that has to move with it — and the direction of the drift is safe: our
// predicate saying "no" where simple-git would have said "yes" costs a PATH prefix, nothing more.
const SIMPLE_GIT_RULE = (arg: string): boolean => /^([a-z]:)?([a-z0-9/.\\_~-]+)$/i.test(arg);

describe("isSimpleGitSafeBinary — never hand simple-git a value it throws on", () => {
  const cases = [
    "git",
    "/usr/bin/git",
    "/opt/homebrew/bin/git",
    "C:\\Program Files\\Git\\cmd\\git.exe", // THE reported failure — a space
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe", // spaces AND parentheses
    "C:\\Users\\bryan\\AppData\\Local\\Programs\\Git\\cmd\\git.exe", // per-user winget install, no space
    "C:\\tools\\git\\cmd\\git.exe",
    "/Users/some one/bin/git", // a POSIX home with a space is the same defect
  ];
  for (const bin of cases) {
    it(`agrees with simple-git about ${JSON.stringify(bin)}`, () => {
      expect(isSimpleGitSafeBinary(bin)).toBe(SIMPLE_GIT_RULE(bin));
    });
  }

  it("rejects the standard Git for Windows install and accepts the standard POSIX one", () => {
    // Stated outright rather than left to the table: this ONE difference is the entire bug.
    expect(isSimpleGitSafeBinary("C:\\Program Files\\Git\\cmd\\git.exe")).toBe(false);
    expect(isSimpleGitSafeBinary("/usr/bin/git")).toBe(true);
  });
});

describe("withGitOnPath — the fallback still finds the binary we resolved", () => {
  it("puts the git directory FIRST so it wins over any other git on PATH", () => {
    const bin = stableGitBin();
    if (!path.isAbsolute(bin)) return; // no git on this box — resolution, not placement, is the failure
    const out = withGitOnPath({ PATH: `/somewhere/else${path.delimiter}/usr/bin` });
    const entries = String(out.PATH).split(path.delimiter);
    expect(entries[0]).toBe(path.dirname(bin));
    expect(entries.slice(1)).toEqual(["/somewhere/else", "/usr/bin"]); // the caller's PATH is kept, not replaced
  });

  it("updates the EXISTING key rather than adding a second spelling", () => {
    // Windows hands us `Path`; spreading process.env keeps that spelling. Writing `PATH` alongside it
    // would give the child two variables that disagree — and which one wins is not ours to decide.
    const out = withGitOnPath({ Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\bryan" });
    expect(Object.keys(out).filter((k) => k.toLowerCase() === "path")).toEqual(["Path"]);
    expect(String(out.Path)).toContain("C:\\Windows\\System32");
    expect(out.USERPROFILE).toBe("C:\\Users\\bryan"); // everything else travels untouched
  });

  it("survives an environment with no PATH at all", () => {
    const out = withGitOnPath({});
    if (!path.isAbsolute(stableGitBin())) return;
    expect(String(out.PATH)).toBe(path.dirname(stableGitBin()));
  });
});
