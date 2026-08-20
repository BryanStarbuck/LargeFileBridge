// Naming the anonymous per-repo tracking directories (artifact_placement_policy.mdx §3.1). Written against
// real directories, because the whole point of the migration is what it does to on-disk NAMES.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateRepoDirNames } from "./migrate-repo-dir-names.js";
import { namedKeyDir, resolveNamedKeyDir, clearKeyedDirCache } from "../shared/store/keyed-dir.js";
import { repoKeyFor } from "../modules/storage/tracking-root.service.js";
import { repoUidFor, repoSlugFor } from "../modules/storage/repo-identity.js";

let tmp: string;
let state: string;
let repo: string;
let syncRepo: string;
// vitest.config.ts points LFB_STATE_DIR at a temp dir for the whole run. RESTORE it rather than deleting
// it: a `delete` here is what let a later spec file write into the LIVE ~/T/_large_files_bridge.
let priorStateDir: string | undefined;

const REMOTE = "https://github.com/ACT3ai/charlie-kirk.git";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-repo-dir-names-"));
  state = path.join(tmp, "state");
  repo = path.join(tmp, "charlie-kirk");
  syncRepo = path.join(tmp, "act3_large_files_bridge");
  priorStateDir = process.env.LFB_STATE_DIR;
  process.env.LFB_STATE_DIR = state;
  clearKeyedDirCache();

  const unit = path.join(state, "pin", "r", "charlie-kirk");
  fs.mkdirSync(unit, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(unit, "config.yaml"),
    ["repo:", `  path: ${repo}`, `  remote: ${REMOTE}`].join("\n"),
  );
});

afterEach(() => {
  if (priorStateDir === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = priorStateDir;
  clearKeyedDirCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Plant a legacy bare-hash directory with one file in it, and return that key. */
function plantLegacy(parent: string, key: string): string {
  fs.mkdirSync(path.join(parent, key), { recursive: true });
  fs.writeFileSync(path.join(parent, key, "repo_storage.yaml"), "repo_storage:\n  name: \"\"\n");
  return key;
}

describe("migrateRepoDirNames", () => {
  it("renames the LOCAL bare-hash directory to <slug>-<repoKey>, keeping its contents", () => {
    const key = plantLegacy(path.join(state, "repos"), repoKeyFor(repo));

    migrateRepoDirNames(state);

    const named = path.join(state, "repos", `charlie-kirk-${key}`);
    expect(fs.existsSync(named)).toBe(true);
    expect(fs.existsSync(path.join(state, "repos", key))).toBe(false);
    expect(fs.existsSync(path.join(named, "repo_storage.yaml"))).toBe(true);
  });

  it("renames the SYNC-REPO subtree by its remote-derived slug, not the local basename", () => {
    const repoKey = repoKeyFor(repo);
    fs.mkdirSync(path.join(state, "repos", repoKey), { recursive: true });
    // The marker's first line is the sync-repo root — that is how the migration discovers the tree.
    fs.writeFileSync(
      path.join(state, "repos", repoKey, ".sync-repo"),
      `${syncRepo}\n${repoUidFor(REMOTE)}\n${repoSlugFor(REMOTE)}\n`,
    );
    const uid = plantLegacy(path.join(syncRepo, "repos"), repoUidFor(REMOTE)!);

    migrateRepoDirNames(state);

    expect(fs.existsSync(path.join(syncRepo, "repos", `charlie-kirk-${uid}`))).toBe(true);
    expect(fs.existsSync(path.join(syncRepo, "repos", uid))).toBe(false);
  });

  it("LEAVES a directory alone when no repo registered here can name it", () => {
    // A teammate's repo: it is in the shared sync repo, but this computer has never seen it. Renaming it
    // would mean inventing a name; the migration must not.
    const repoKey = repoKeyFor(repo);
    fs.mkdirSync(path.join(state, "repos", repoKey), { recursive: true });
    fs.writeFileSync(path.join(state, "repos", repoKey, ".sync-repo"), `${syncRepo}\n${repoUidFor(REMOTE)}\n`);
    plantLegacy(path.join(syncRepo, "repos"), "0123456789ab");

    migrateRepoDirNames(state);

    expect(fs.existsSync(path.join(syncRepo, "repos", "0123456789ab"))).toBe(true);
  });

  it("never overwrites: a pre-existing named directory leaves the bare one in place", () => {
    const key = repoKeyFor(repo);
    plantLegacy(path.join(state, "repos"), key);
    fs.mkdirSync(path.join(state, "repos", `charlie-kirk-${key}`), { recursive: true });

    migrateRepoDirNames(state);

    expect(fs.existsSync(path.join(state, "repos", key))).toBe(true);
    expect(fs.existsSync(path.join(state, "repos", `charlie-kirk-${key}`))).toBe(true);
  });

  it("is idempotent — a second run is a no-op and does not re-rename an already-named directory", () => {
    const key = plantLegacy(path.join(state, "repos"), repoKeyFor(repo));
    migrateRepoDirNames(state);
    const before = fs.readdirSync(path.join(state, "repos")).sort();
    migrateRepoDirNames(state);
    expect(fs.readdirSync(path.join(state, "repos")).sort()).toEqual(before);
    expect(before).toEqual([`charlie-kirk-${key}`]);
  });
});

describe("resolveNamedKeyDir", () => {
  it("prefers <slug>-<key> when it exists", () => {
    const parent = path.join(tmp, "repos");
    fs.mkdirSync(path.join(parent, "charlie-kirk-abcabcabc123"), { recursive: true });
    expect(resolveNamedKeyDir(parent, "abcabcabc123", "charlie-kirk")).toBe(
      path.join(parent, "charlie-kirk-abcabcabc123"),
    );
  });

  it("finds a LEGACY bare-key directory an older build wrote", () => {
    const parent = path.join(tmp, "repos");
    fs.mkdirSync(path.join(parent, "abcabcabc123"), { recursive: true });
    expect(resolveNamedKeyDir(parent, "abcabcabc123", "charlie-kirk")).toBe(path.join(parent, "abcabcabc123"));
  });

  it("finds a directory a PEER computer named differently — matching is on the key suffix", () => {
    const parent = path.join(tmp, "repos");
    fs.mkdirSync(path.join(parent, "ck-mirror-abcabcabc123"), { recursive: true });
    expect(resolveNamedKeyDir(parent, "abcabcabc123", "charlie-kirk")).toBe(
      path.join(parent, "ck-mirror-abcabcabc123"),
    );
  });

  it("falls back to the name to CREATE when nothing exists yet", () => {
    const parent = path.join(tmp, "repos");
    expect(resolveNamedKeyDir(parent, "abcabcabc123", "charlie-kirk")).toBe(
      path.join(parent, "charlie-kirk-abcabcabc123"),
    );
  });

  it("keeps the bare key when there is no slug, so a remote-less repo is unchanged", () => {
    expect(namedKeyDir(null, "abcabcabc123")).toBe("abcabcabc123");
    expect(namedKeyDir("Charlie Kirk", "abcabcabc123")).toBe("charlie_kirk-abcabcabc123");
  });
});
