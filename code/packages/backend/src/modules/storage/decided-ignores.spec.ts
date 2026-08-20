// Locks `ensureDecidedIgnores` — the ledger-scoped half of the git-ignore axis (decisions.mdx §7).
//
// It is the guard on the two paths where LFB itself WRITES a big file into a working tree (the pin pass's
// fetch-missing and the interactive Pull down). Before this existed, the axis lived only in `recordDecision`
// on the deciding machine, so a decision that ARRIVED over the sync repo left this computer materializing
// the bytes into a repo git was still offering to commit.
//
// The rule it must not break: it ASSERTS, it never DECIDES. A path the ledger does not carry as
// `gitignore: true` is left alone — including a file the user pinned (the two axes are independent, §1) and
// one whose ledger record is a tombstone.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { DecisionEvent } from "@lfb/shared";

let root: string;
let stateDir: string;

/** Write the Local-Storage decision ledger for `root` — the file a sync-repo fold delivers. */
async function writeLedger(events: DecisionEvent[]): Promise<void> {
  const { repoStateDir } = await import("./tracking-root.service.js");
  const dir = repoStateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "decisions.yaml"), YAML.stringify({ schema_version: 1, events }), "utf8");
}

function ev(p: string, over: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    sid: "r:c2a759acab00",
    path: p,
    fingerprint: null,
    asked: true,
    ipfs: true,
    gitignore: true,
    decided_by: "teammate@example.com",
    decided_at: "2026-08-19T10:00:00.000Z",
    ...over,
  };
}

function gitignore(): string {
  try {
    return fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  } catch {
    return "";
  }
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-decided-state-"));
  process.env.LFB_STATE_DIR = stateDir;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lfb-decided-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("ensureDecidedIgnores — assert the recorded axis, never decide", () => {
  it("writes the line for a path the ledger carries as git-ignored", async () => {
    await writeLedger([ev("videos/hero.mov")]);
    const { ensureDecidedIgnores } = await import("./decisions.service.js");
    expect(ensureDecidedIgnores(root, ["videos/hero.mov"])).toBe(1);
    expect(gitignore()).toBe("/videos/hero.mov\n");
  });

  it("leaves a PINNED-but-not-ignored file alone — the two axes stay independent", async () => {
    await writeLedger([ev("videos/pinned-only.mov", { gitignore: false })]);
    const { ensureDecidedIgnores } = await import("./decisions.service.js");
    expect(ensureDecidedIgnores(root, ["videos/pinned-only.mov"])).toBe(0);
    expect(gitignore()).toBe("");
  });

  it("leaves a path with NO ledger record alone, even in the same batch as a decided one", async () => {
    await writeLedger([ev("videos/decided.mov")]);
    const { ensureDecidedIgnores } = await import("./decisions.service.js");
    expect(ensureDecidedIgnores(root, ["videos/decided.mov", "videos/undecided.mov"])).toBe(1);
    expect(gitignore()).toBe("/videos/decided.mov\n");
  });

  it("honors a TOMBSTONE — asked:false is Undecided, not a standing ignore", async () => {
    await writeLedger([
      ev("videos/gone.mov"),
      ev("videos/gone.mov", { asked: false, decided_at: "2026-08-19T11:00:00.000Z", decided_by: "deleted" }),
    ]);
    const { ensureDecidedIgnores } = await import("./decisions.service.js");
    expect(ensureDecidedIgnores(root, ["videos/gone.mov"])).toBe(0);
    expect(gitignore()).toBe("");
  });

  it("matches a Windows-spelled ledger key against the POSIX path the fetch is about to write", async () => {
    await writeLedger([ev("videos\\hero.mov")]);
    const { ensureDecidedIgnores } = await import("./decisions.service.js");
    expect(ensureDecidedIgnores(root, ["videos/hero.mov"])).toBe(1);
    expect(gitignore()).toBe("/videos/hero.mov\n");
  });

  it("no ledger at all is a no-op, not a throw", async () => {
    const { ensureDecidedIgnores } = await import("./decisions.service.js");
    expect(ensureDecidedIgnores(root, ["videos/hero.mov"])).toBe(0);
    expect(gitignore()).toBe("");
  });
});
