// THE INHERITED ASKPASS ENVIRONMENT (git_backbone.mdx §5). `simple-git` treats `GIT_ASKPASS`/`SSH_ASKPASS`
// in the environment as an unsafe-config vector and refuses to run git AT ALL unless the caller opts in:
//
//   Git commit failed: Use of "GIT_ASKPASS" is not permitted without enabling allowUnsafeAskPass
//
// VS Code exports both into every integrated terminal and every child of one, so a backend started from a
// terminal loses its whole backbone — silently, since only the log says so. Not opting in to the unsafe
// flag is the point: this process declares `GIT_TERMINAL_PROMPT=0`, and an askpass helper is a prompt.
import { describe, it, expect } from "vitest";
import { NON_INTERACTIVE_ENV_STRIP } from "./git.service.js";

// The exact variables VS Code injects into a terminal's children.
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
    const clean = { PATH: "/usr/bin", HOME: "/home/user", GIT_TERMINAL_PROMPT: "0" };
    const after = { ...clean };
    for (const k of NON_INTERACTIVE_ENV_STRIP) delete (after as Record<string, string>)[k];
    expect(after).toEqual(clean);
  });
});
