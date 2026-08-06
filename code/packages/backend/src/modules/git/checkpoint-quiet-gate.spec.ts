// THE QUIET GATE HAS TWO DOORS, and only one of them was guarded (git_backbone.mdx §6.6).
//
// `commitAndPushInner` runs the gate before it decides to commit. But `pullInner` reaches a commit by a
// completely separate route: `checkpointOwnWrites()` stages every dirty LFB-generated path and commits it,
// so the merge that follows is always legal. That path had NO semantic opinion about what it was
// committing — so any volatile-only write that happened to be dirty at pull time became a commit, and then
// a push, BEFORE the gate ever looked at it.
//
// This is not a theoretical window. `repo_storage.yaml`'s `last_scan` block is a SCAN HEARTBEAT — `at`
// re-stamps every pass, `on_device`/`headless` move with whichever computer took it — and the SCAN path
// writes it into the sync repo (`mirrorToSyncRepo`) at moments entirely unrelated to the git cycle. So the
// tree is routinely dirty with pure churn exactly when the checkpoint runs. Measured on the live company
// repo: whole "LFB: tracking" commits whose entire diff is that block across a handful of repos.
//
// A choke point with a second door in it is not a choke point.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { GitBackbone } from "./git.service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** An SDL working copy with an `origin` it can fetch from, so `pull()` runs its real path. */
function repoWithOrigin(): { work: string; origin: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-checkpoint-"));
  dirs.push(root);
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const work = path.join(root, "work");
  git(root, "clone", "-q", origin, work);
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Test");
  return { work, origin };
}

function repoStorageYaml(scanAt: string, files: number): string {
  return YAML.stringify({
    repo_storage: {
      files,
      last_scan: { at: scanAt, on_device: "tower", headless: false },
    },
  });
}

function commitCount(dir: string): number {
  return parseInt(git(dir, "rev-list", "--count", "HEAD").trim(), 10);
}

/** Seed a committed `repos/<uid>/repo_storage.yaml` and push it, so HEAD has something to compare against. */
async function seeded(): Promise<{ work: string; rel: string }> {
  const { work } = repoWithOrigin();
  const rel = "repos/83e62afc2c80/repo_storage.yaml";
  fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  fs.writeFileSync(path.join(work, rel), repoStorageYaml("2026-08-01T10:00:00Z", 12));
  git(work, "add", "-A");
  git(work, "commit", "-qm", "seed");
  git(work, "push", "-q", "origin", "main");
  // One full cycle so LFB's own control files (.gitattributes/.gitignore) are already committed and
  // cannot be mistaken for churn by the assertions below.
  const backbone = await GitBackbone.resolve("test-storage", work);
  await backbone!.pull({ ran: true });
  await backbone!.commitAndPush({ ran: true });
  return { work, rel };
}

describe("checkpointOwnWrites — the pre-merge checkpoint obeys the quiet gate", () => {
  it("makes NO commit when the only dirty write is a scan heartbeat", async () => {
    const { work, rel } = await seeded();
    const before = commitCount(work);

    // The scan path rewrites the mirror mid-cycle: same file counts, new `last_scan` stamp and device.
    fs.writeFileSync(path.join(work, rel), repoStorageYaml("2026-08-01T10:15:00Z", 12));

    const backbone = await GitBackbone.resolve("test-storage", work);
    await backbone!.pull({ ran: true });

    expect(commitCount(work)).toBe(before); // the heartbeat never became a commit
    // …and it did not simply stay staged for the next pass to commit either: the gate reverts.
    expect(git(work, "status", "--porcelain").trim()).toBe("");
  });

  it("still checkpoints a REAL change, so the merge stays legal", async () => {
    const { work, rel } = await seeded();
    const before = commitCount(work);

    // A real change to the same file — the file count moved, which is exactly what the backbone carries.
    fs.writeFileSync(path.join(work, rel), repoStorageYaml("2026-08-01T10:15:00Z", 13));

    const backbone = await GitBackbone.resolve("test-storage", work);
    await backbone!.pull({ ran: true });

    expect(commitCount(work)).toBe(before + 1);
    expect(git(work, "log", "-1", "--pretty=%s")).toMatch(/checkpoint/);
    expect(git(work, "status", "--porcelain").trim()).toBe(""); // tree clean → the merge can always run
  });

  it("checkpoints a real change even when a volatile-only one is dirty alongside it", async () => {
    // The mixed case is the common one, and the gate must be per-FILE: one worthless diff in the batch
    // must not suppress the commit of the meaningful one (nor vice versa).
    const { work, rel } = await seeded();
    const device = "devices/tower.yaml";
    fs.mkdirSync(path.join(work, "devices"), { recursive: true });
    fs.writeFileSync(
      path.join(work, device),
      YAML.stringify({ device: { name: "tower", hardware: { primary_ip: "192.168.1.4", ip_addresses: ["192.168.1.4"] } } }),
    );
    git(work, "add", "-A");
    git(work, "commit", "-qm", "seed device");
    const before = commitCount(work);

    // Volatile: the laptop picked up a new link-local address. Real: the mirror's file count moved.
    fs.writeFileSync(
      path.join(work, device),
      YAML.stringify({
        device: { name: "tower", hardware: { primary_ip: "192.168.1.9", ip_addresses: ["192.168.1.9", "fe80::1"] } },
      }),
    );
    fs.writeFileSync(path.join(work, rel), repoStorageYaml("2026-08-01T10:15:00Z", 14));

    const backbone = await GitBackbone.resolve("test-storage", work);
    await backbone!.pull({ ran: true });

    expect(commitCount(work)).toBe(before + 1);
    const changed = git(work, "show", "--name-only", "--pretty=format:", "HEAD").trim();
    expect(changed).toContain(rel); // the real change travelled
    expect(changed).not.toContain(device); // the IP churn did not
  });
});
