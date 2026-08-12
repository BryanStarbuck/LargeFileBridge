// THE INHERITED ASKPASS ENVIRONMENT (git_backbone.mdx §5). On 2026-08-12, PC-10 had every LFB service
// installed, enabled and firing on schedule, the Scans page showed all of them green — and the machine had
// not made a single git commit since it was set up. Twelve hours of passes, its own device file still
// untracked, `0 repo(s) with your commits`, and one line repeating in the log:
//
//   Git commit failed: Use of "GIT_ASKPASS" is not permitted without enabling allowUnsafeAskPass
//
// `simple-git` treats `GIT_ASKPASS`/`SSH_ASKPASS` in the environment as an unsafe-config vector and refuses
// to run git AT ALL unless the caller opts in. VS Code exports both into every integrated terminal and every
// child of one, so a backend started from a terminal — the ordinary way this app is run in development —
// inherits them and loses its whole backbone. The right answer is not to opt in to the unsafe flag: this
// process already declares `GIT_TERMINAL_PROMPT=0`, and an askpass helper is a prompt by another name.
import { describe, it, expect } from "vitest";
import { NON_INTERACTIVE_ENV_STRIP } from "./git.service.js";

// The exact variables VS Code injects, captured from the live PC-10 backend's /proc/<pid>/environ.
const VSCODE_INJECTED = [
  "GIT_ASKPASS",
  "VSCODE_GIT_ASKPASS_NODE",
  "VSCODE_GIT_ASKPASS_MAIN",
  "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
  "VSCODE_GIT_IPC_HANDLE",
];

describe("NON_INTERACTIVE_ENV_STRIP — no git child may inherit a prompt", () => {
  it("removes every variable simple-git refuses to run alongside", () => {
    for (const k of ["GIT_ASKPASS", "SSH_ASKPASS"]) {
      expect(NON_INTERACTIVE_ENV_STRIP).toContain(k);
    }
  });

  it("removes the whole VS Code askpass mechanism, not just its entry point", () => {
    // Leaving half of it behind is how the next reader concludes it is still wired up.
    for (const k of VSCODE_INJECTED) expect(NON_INTERACTIVE_ENV_STRIP).toContain(k);
  });

  it("still removes the editor vars — the older hang guard this list grew out of", () => {
    for (const k of ["EDITOR", "VISUAL", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR"]) {
      expect(NON_INTERACTIVE_ENV_STRIP).toContain(k);
    }
  });

  it("leaves an environment with none of them exactly as it was", () => {
    const clean = { PATH: "/usr/bin", HOME: "/home/pc-10", GIT_TERMINAL_PROMPT: "0" };
    const after = { ...clean };
    for (const k of NON_INTERACTIVE_ENV_STRIP) delete (after as Record<string, string>)[k];
    expect(after).toEqual(clean);
  });
});
