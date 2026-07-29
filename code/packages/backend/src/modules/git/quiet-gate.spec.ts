// THE QUIET GATE — the backbone commits only when something REAL happened (git_backbone.mdx §6.6).
//
// The defect these tests pin down, measured on the live personal tracking repo on 2026-07-29:
//
//     2,437 commits in 7 days — 2,322 of them a touch of `devices/*.yaml`,
//     and 58 of the last 60 of those had a one-line diff:  -updated_at: … / +updated_at: …
//
// Nobody added a file, compressed anything, or produced a transcript for the overwhelming majority of those
// commits. `commitAndPushInner` ran `git add -A` and committed whatever that staged, with no opinion about
// WHAT changed — so the "are we quiet?" guarantee was only ever as strong as the discipline of every writer
// that touches the SDL, and one careless writer re-floods the repo (and, on a shared company remote, turns
// every cycle into a merge race that costs the push).
//
// The gate makes it structural instead: a staged modification that is provably meaningless — same canonical
// content as HEAD once volatile paths are removed — is reverted before the commit decision is taken.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { GitBackbone, volatileYamlPathsFor } from "./git.service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A tracking repo holding one device file, already committed — the shape of a real SDL.
 *
 * The `.gitattributes` LFB maintains for the backbone's union merges is seeded here too. In production that
 * file is written once, on the first cycle a storage ever runs; leaving it to appear mid-test would make a
 * legitimate one-time setup commit look like churn and hide the thing these tests measure.
 */
function repoWithDevice(device: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-quiet-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "devices"));
  fs.writeFileSync(path.join(dir, "devices", "tower.yaml"), YAML.stringify(device));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  return dir;
}

/** Run one cycle so LFB's own control files (`.gitattributes`, `.gitignore`) are already committed. */
async function settleSetup(dir: string): Promise<void> {
  const backbone = await GitBackbone.resolve("test-storage", dir);
  await backbone!.commitAndPush({} as never);
}

function commitCount(dir: string): number {
  return parseInt(git(dir, "rev-list", "--count", "HEAD").trim(), 10);
}

/** Rewrite the device file the way a device pass does, then run the real commit path. */
async function runCycle(dir: string, mutate: (doc: any) => void): Promise<void> {
  const file = path.join(dir, "devices", "tower.yaml");
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  mutate(doc);
  fs.writeFileSync(file, YAML.stringify(doc));
  const backbone = await GitBackbone.resolve("test-storage", dir);
  expect(backbone).not.toBeNull();
  // No `origin` here, so this exercises stage → gate → commit and stops before any push.
  await backbone!.commitAndPush({} as never);
}

const DEVICE = {
  schema_version: 1,
  updated_at: "2026-07-29T14:15:29.811Z",
  device: {
    id: "fdc6e91d",
    name: "bryan-mac-pro",
    hardware: { chip: "M2 Ultra", primary_ip: "192.168.50.167", ip_addresses: ["192.168.50.167", "fe80::1"] },
  },
};

describe("the quiet gate — a self-moving field never becomes a commit (§6.6)", () => {
  it("makes NO commit when only the timestamp moved", async () => {
    const dir = repoWithDevice(DEVICE);
    await settleSetup(dir);
    const before = commitCount(dir);
    await runCycle(dir, (d) => (d.updated_at = "2026-07-29T16:36:05.339Z"));
    expect(commitCount(dir)).toBe(before); // this is the 58-of-60 case, gone
    expect(git(dir, "status", "--porcelain").trim()).toBe(""); // and the churn is not left behind to re-stage
  });

  it("makes NO commit when only the network addresses moved", async () => {
    // A laptop grows and drops `fe80::` link-local addresses as interfaces, VPNs and AirDrop come and go.
    // Left in the change test, this simply replaces a 1-line churn with a 25-line one.
    const dir = repoWithDevice(DEVICE);
    await settleSetup(dir);
    const before = commitCount(dir);
    await runCycle(dir, (d) => {
      d.updated_at = "2026-07-29T16:36:05.339Z";
      d.device.hardware.primary_ip = "192.168.50.9";
      d.device.hardware.ip_addresses = ["192.168.50.9", "fe80::9", "fe80::2"];
    });
    expect(commitCount(dir)).toBe(before);
  });

  it("makes NO commit when the document is merely REORDERED or rewritten identically", async () => {
    const dir = repoWithDevice(DEVICE);
    await settleSetup(dir);
    const before = commitCount(dir);
    await runCycle(dir, (d) => {
      d.device = { hardware: d.device.hardware, name: d.device.name, id: d.device.id }; // schema order
    });
    expect(commitCount(dir)).toBe(before);
  });

  it("DOES commit when a real identity field changes", async () => {
    // The gate must never be so eager that it swallows the news the backbone exists to carry.
    const dir = repoWithDevice(DEVICE);
    await settleSetup(dir);
    const before = commitCount(dir);
    await runCycle(dir, (d) => (d.device.name = "bryan-tower"));
    expect(commitCount(dir)).toBe(before + 1);
    expect(git(dir, "show", "--stat", "HEAD")).toMatch(/devices\/tower\.yaml/);
  });

  it("DOES commit a real artifact, and carries the volatile churn along with it", async () => {
    // A transcript IS the user's work. The device timestamp riding along on that commit is free — what the
    // gate forbids is a commit that exists ONLY for the timestamp.
    const dir = repoWithDevice(DEVICE);
    await settleSetup(dir);
    const before = commitCount(dir);
    fs.writeFileSync(path.join(dir, "clip.mp4.transcription"), "hello world\n");
    await runCycle(dir, (d) => (d.updated_at = "2026-07-29T16:40:00.000Z"));
    expect(commitCount(dir)).toBe(before + 1);
    expect(git(dir, "show", "--name-only", "HEAD")).toMatch(/clip\.mp4\.transcription/);
  });

  it("never reverts a file it does not own", async () => {
    // The gate only ever touches LFB's own YAML. A user's file is not ours to judge or discard.
    const dir = repoWithDevice(DEVICE);
    await settleSetup(dir);
    const before = commitCount(dir);
    fs.writeFileSync(path.join(dir, "notes.md"), "the user's own words\n");
    await runCycle(dir, (d) => (d.updated_at = "2026-07-29T16:41:00.000Z"));
    expect(commitCount(dir)).toBe(before + 1);
    expect(fs.readFileSync(path.join(dir, "notes.md"), "utf8")).toBe("the user's own words\n");
  });

  it("stands down mid-merge, so a merge is never left unfinished", async () => {
    // The one case where the gate must NOT act. Mid-merge the commit being prepared is the merge itself.
    // Reverting a path here would discard the conflict resolution, and if that left nothing staged we would
    // skip the commit and leave MERGE_HEAD dangling — an unfinished merge, which is far worse than a
    // redundant commit.
    const dir = repoWithDevice(DEVICE);
    await settleSetup(dir);
    const file = path.join(dir, "devices", "tower.yaml");

    // A branch that touches ONLY the volatile timestamp — so without the mid-merge guard the gate would
    // find the merge result canonically equal to HEAD and revert it.
    git(dir, "checkout", "-q", "-b", "peer");
    const peerDoc = YAML.parse(fs.readFileSync(file, "utf8"));
    peerDoc.updated_at = "2026-07-29T18:00:00.000Z";
    fs.writeFileSync(file, YAML.stringify(peerDoc));
    git(dir, "commit", "-qam", "peer stamp");
    git(dir, "checkout", "-q", "main");
    const ourDoc = YAML.parse(fs.readFileSync(file, "utf8"));
    ourDoc.updated_at = "2026-07-29T18:30:00.000Z";
    fs.writeFileSync(file, YAML.stringify(ourDoc));
    git(dir, "commit", "-qam", "our stamp");

    // Leave a real merge in progress, then run the commit path exactly as the cycle does.
    try {
      git(dir, "merge", "--no-commit", "--no-ff", "peer");
    } catch {
      git(dir, "checkout", "--ours", "--", "devices/tower.yaml"); // conflicted → resolve like §4.3.1 does
      git(dir, "add", "devices/tower.yaml");
    }
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);

    const backbone = await GitBackbone.resolve("test-storage", dir);
    await backbone!.commitAndPush({} as never);

    // The merge was COMPLETED, not abandoned.
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(dir, "rev-list", "--count", "--merges", "HEAD").trim()).toBe("1");
  });

  it("goes quiet and STAYS quiet across repeated idle cycles", async () => {
    // The whole point: a computer where the user did nothing must add nothing, pass after pass after pass.
    const dir = repoWithDevice(DEVICE);
    await settleSetup(dir);
    const before = commitCount(dir);
    for (let i = 0; i < 6; i++) {
      await runCycle(dir, (d) => (d.updated_at = `2026-07-29T17:0${i}:00.000Z`));
    }
    expect(commitCount(dir)).toBe(before);
  });
});

describe("volatileYamlPathsFor — what is allowed to move on its own", () => {
  it("knows a device file republishes its network addresses", () => {
    expect(volatileYamlPathsFor("devices/bryan-mac-pro.yaml")).toEqual([
      "device.hardware.primary_ip",
      "device.hardware.ip_addresses",
    ]);
    expect(volatileYamlPathsFor(".lfbridge/devices/bryan-mac-pro.yaml")).toHaveLength(2);
  });

  it("gives every other LFB-owned YAML the timestamp-only surface", () => {
    expect(volatileYamlPathsFor("manifest.yaml")).toEqual([]);
    expect(volatileYamlPathsFor("decisions.yaml")).toEqual([]);
  });

  it("returns null for anything it does not own, so that file always keeps its commit", () => {
    // An unknown file is never provably meaningless. Silence is only ever earned, never assumed.
    expect(volatileYamlPathsFor("notes.md")).toBeNull();
    expect(volatileYamlPathsFor("some/user/config.yaml")).toBeNull();
  });
});
