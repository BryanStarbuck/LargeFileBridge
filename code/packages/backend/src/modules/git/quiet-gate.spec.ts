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

/**
 * A stamp `mins` minutes from now. The tests below must sit INSIDE the heartbeat floor
 * (git.service.ts HEARTBEAT_MAX_AGE_MS): the gate deliberately lets a device record through once its
 * PUBLISHED stamp has aged past that floor, so a fixture frozen at a hard-coded past date would exercise
 * the heartbeat exception rather than the quiet gate it means to test. The staleness path has its own
 * test at the bottom of this describe, and its unit tests in heartbeat-floor.spec.ts.
 */
const stamp = (mins: number): string => new Date(Date.now() + mins * 60_000).toISOString();

const DEVICE = {
  schema_version: 1,
  updated_at: stamp(0),
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
    await runCycle(dir, (d) => (d.updated_at = stamp(1)));
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
      d.updated_at = stamp(1);
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
    await runCycle(dir, (d) => (d.updated_at = stamp(2)));
    expect(commitCount(dir)).toBe(before + 1);
    expect(git(dir, "show", "--name-only", "HEAD")).toMatch(/clip\.mp4\.transcription/);
  });

  it("never reverts a file it does not own", async () => {
    // The gate only ever touches LFB's own YAML. A user's file is not ours to judge or discard.
    const dir = repoWithDevice(DEVICE);
    await settleSetup(dir);
    const before = commitCount(dir);
    fs.writeFileSync(path.join(dir, "notes.md"), "the user's own words\n");
    await runCycle(dir, (d) => (d.updated_at = stamp(3)));
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
    peerDoc.updated_at = stamp(4);
    fs.writeFileSync(file, YAML.stringify(peerDoc));
    git(dir, "commit", "-qam", "peer stamp");
    git(dir, "checkout", "-q", "main");
    const ourDoc = YAML.parse(fs.readFileSync(file, "utf8"));
    ourDoc.updated_at = stamp(5);
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
      await runCycle(dir, (d) => (d.updated_at = stamp(6 + i)));
    }
    expect(commitCount(dir)).toBe(before);
  });

  it("DOES publish a device heartbeat once the PUBLISHED stamp has aged past the floor", async () => {
    // THE HEARTBEAT FLOOR (devices.mdx §7.1) — the one exception, and the reason it exists. `deviceRows()`
    // reads a peer's `lastSeen` off this very `updated_at`, so silence forever means liveness is
    // unanswerable: on 2026-08-10 this Mac Pro's published record was stamped a week earlier (the last day
    // anything substantive changed) and every peer concluded it had been offline since, which is why
    // pull-downs failed with "<computer> looks offline" about computers that were running the whole time.
    const dir = repoWithDevice({ ...DEVICE, updated_at: stamp(-7 * 24 * 60) }); // published a week ago
    await settleSetup(dir);
    const before = commitCount(dir);
    await runCycle(dir, (d) => (d.updated_at = stamp(0)));
    expect(commitCount(dir)).toBe(before + 1);
    expect(git(dir, "show", "--name-only", "HEAD")).toMatch(/devices\/tower\.yaml/);

    // And it goes quiet again immediately: the floor is a FLOOR, not a new flood. The stamp it just
    // published is fresh, so the next six idle cycles add nothing.
    const afterBeat = commitCount(dir);
    for (let i = 0; i < 6; i++) await runCycle(dir, (d) => (d.updated_at = stamp(i + 1)));
    expect(commitCount(dir)).toBe(afterBeat);
  });
});

describe("the quiet gate — a repo's scan heartbeat never becomes a commit (§6.6)", () => {
  // The mirrored per-repo tracking payload every company/Personal SDL carries (storage_company.mdx §8.4.1).
  const MIRROR = "repos/eb94a756b52e/repo_storage.yaml";
  const REPO_STORAGE = {
    repo_storage: {
      schema_version: 1,
      name: "",
      counts: { videos: 3, images: 0, large: 3 },
      policy: { recommend_compress: true, recommend_ipfs_pin: true, recommend_transcribe: false },
      last_scan: { at: "2026-08-04T02:32:31.463Z", headless: true, on_device: "bryanstarbuck-macbook-pro" },
    },
  };

  /** An SDL that already carries a committed mirror of one repo's tracking state. */
  function repoWithMirror(): string {
    const dir = repoWithDevice(DEVICE);
    fs.mkdirSync(path.join(dir, path.dirname(MIRROR)), { recursive: true });
    fs.writeFileSync(path.join(dir, MIRROR), YAML.stringify(REPO_STORAGE));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "seed mirror");
    return dir;
  }

  /** Rewrite the mirror the way a scan pass does, then run the real commit path. */
  async function rescan(dir: string, mutate: (doc: any) => void): Promise<void> {
    const file = path.join(dir, MIRROR);
    const doc = YAML.parse(fs.readFileSync(file, "utf8"));
    mutate(doc);
    fs.writeFileSync(file, YAML.stringify(doc));
    const backbone = await GitBackbone.resolve("test-storage", dir);
    await backbone!.commitAndPush({} as never);
  }

  it("makes NO commit when only the scan stamp moved", async () => {
    const dir = repoWithMirror();
    await settleSetup(dir);
    const before = commitCount(dir);
    await rescan(dir, (d) => (d.repo_storage.last_scan.at = "2026-08-04T08:40:32.287Z"));
    expect(commitCount(dir)).toBe(before);
    expect(git(dir, "status", "--porcelain").trim()).toBe("");
  });

  it("makes NO commit when another computer took the pass", async () => {
    // The live shape: `at`, `headless` and `on_device` all move together as a different machine (or the
    // background worker) runs the scan. Suppressing the timestamp alone would have left this untouched.
    const dir = repoWithMirror();
    await settleSetup(dir);
    const before = commitCount(dir);
    await rescan(dir, (d) => {
      d.repo_storage.last_scan = { at: "2026-08-04T12:46:41.229Z", headless: false, on_device: "bryan-mac-pro" };
    });
    expect(commitCount(dir)).toBe(before);
  });

  it("makes NO commit when a peer's scrub blanks the block back to its default", async () => {
    // `mirrorToSyncRepo` holds `last_scan` at the schema default; a machine on an older build re-stamps the
    // real value. Without the gate the two ping-pong a commit per cycle until the whole fleet upgrades.
    const dir = repoWithMirror();
    await settleSetup(dir);
    const before = commitCount(dir);
    await rescan(dir, (d) => (d.repo_storage.last_scan = { on_device: "", headless: false }));
    expect(commitCount(dir)).toBe(before);
  });

  it("makes NO commit when only this computer's file COUNTS moved", async () => {
    // `counts` is derived from THIS computer's file index (`refreshCounts` → `readStorageIndex`), so a
    // computer that has not pulled a repo's big files down legitimately reports different numbers from one
    // that has. Mirroring it verbatim meant the two overwrote each other every cycle — a commit per repo per
    // cycle from a value that describes the machine, not the repo. `mirrorToSyncRepo` now scrubs it at the
    // writer; this gate is what holds while a peer is still on an older build (same argument as `last_scan`).
    const dir = repoWithMirror();
    await settleSetup(dir);
    const before = commitCount(dir);
    await rescan(dir, (d) => {
      d.repo_storage.counts.videos = 4;
      d.repo_storage.counts.large = 4;
    });
    expect(commitCount(dir)).toBe(before);
  });

  it("DOES commit when the repo's real SHARED state changes", async () => {
    // `policy` and `name` are user-editable and mean the same thing on every computer — the fields the
    // backbone exists to carry. Suppressing these would be the opposite failure: a quiet gate that eats the
    // user's actual change.
    const dir = repoWithMirror();
    await settleSetup(dir);
    const before = commitCount(dir);
    await rescan(dir, (d) => {
      d.repo_storage.policy.recommend_transcribe = true;
      d.repo_storage.last_scan.at = "2026-08-04T09:00:00.000Z"; // rides along, as it should
    });
    expect(commitCount(dir)).toBe(before + 1);
    expect(git(dir, "show", "HEAD")).toMatch(/2026-08-04T09:00:00\.000Z/);
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

  it("knows a repo's tracking state re-stamps its scan heartbeat AND its machine-local counts", () => {
    // `counts` is derived from THIS computer's file index (refreshCounts), so two computers holding
    // different subsets of a repo's big files overwrite each other's number every cycle — a commit per repo
    // per cycle from a value that describes the machine, not the repo. Same class as `last_scan`.
    const volatile = ["repo_storage.last_scan", "repo_storage.counts"];
    expect(volatileYamlPathsFor("repos/eb94a756b52e/repo_storage.yaml")).toEqual(volatile);
    expect(volatileYamlPathsFor(".lfbridge/repo_storage.yaml")).toEqual(volatile);
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
