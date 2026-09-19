// A WORKING repo's artifacts belong in its company/Personal sync repo, not in its own `.lfbridge/`
// (artifact_placement_policy.mdx §0.5). Found live 2026-09-19: 5,545 .ocr / .ai_description / .transcription
// files under ~/BGit/Bryan_git/charlie-kirk/.lfbridge/ while ~/BGit/act3/act3_large_files_bridge/ — the ACT3
// company repo that exists to hold them — was cloned on the same machine.
//
// Four things have to hold together or the fix is worse than the bug:
//   1. the WRITE path picks the sync repo (and only one that is really cloned here);
//   2. the "already done?" probe FINDS an artifact there — or every one is regenerated (and re-billed);
//   3. the Category-B state copy never drags thousands of artifacts down into Local Storage;
//   4. the migration moves what the old code wrote, without losing a newer copy.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setSyncRepoMarker, reconcileFromSyncRepo } from "../modules/storage/tracking-sync.service.js";
import { repoStateDir } from "../modules/storage/tracking-root.service.js";
import {
  syncRepoAdmitsRemote,
  workingRepoArtifactBase,
  artifactPathForPlacement,
  OCR_EXT,
} from "../modules/storage/artifact-placement.service.js";
import { analysisOutputsFromDisk } from "../modules/storage/tracking.service.js";
import { migrateRepoLfbridgeToSync, LFBRIDGE_MOVED_LATCH } from "./migrate-repo-lfbridge-to-sync.js";

const REMOTE = "https://github.com/ACT3ai/charlie-kirk.git";
const prevStateDir = process.env.LFB_STATE_DIR;
let tmp: string;
let repoRoot: string;
let syncRepo: string;
let mirrorDir: string;

const write = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
};

/** A working repo whose `.git/config` names `remote` as origin (what readGitRemote reads). */
const gitRepo = (root: string, remote: string): void => {
  write(path.join(root, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-repo-lfbridge-sync-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "charlie-kirk");
  gitRepo(repoRoot, REMOTE);
  syncRepo = path.join(tmp, "act3_large_files_bridge");
  fs.mkdirSync(path.join(syncRepo, ".git"), { recursive: true });
  // The company claims ONLY its own forge org (the confidentiality fence, artifact_placement_policy.mdx §0.6).
  write(path.join(syncRepo, "storage.yaml"), "name: Act3\ntype: company\ncompany:\n  company_name: Act3\n  owner_slugs:\n    - ACT3ai\n");
  setSyncRepoMarker(repoRoot, syncRepo, REMOTE);
  const marker = fs.readFileSync(path.join(repoStateDir(repoRoot), ".sync-repo"), "utf8").split("\n");
  mirrorDir = path.join(syncRepo, "repos", `${marker[2]!.trim()}-${marker[1]!.trim()}`);
  fs.mkdirSync(mirrorDir, { recursive: true });
});

afterEach(() => {
  // RESTORE, never delete: a deleted LFB_STATE_DIR makes the next spec file write into the REAL state root.
  if (prevStateDir === undefined) delete process.env.LFB_STATE_DIR;
  else process.env.LFB_STATE_DIR = prevStateDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("where a working repo's artifacts are written", () => {
  it("goes to the sync repo's mirror subtree, not the repo's own .lfbridge/", () => {
    expect(workingRepoArtifactBase(repoRoot)).toBe(mirrorDir);
    expect(artifactPathForPlacement(repoRoot, "site/img/a.jpg", OCR_EXT, "lfbridge", "repo")).toBe(
      path.join(mirrorDir, "site/img/a.jpg.ocr"),
    );
  });

  it("falls back to .lfbridge/ when the sync repo is not cloned on this computer", () => {
    fs.rmSync(path.join(syncRepo, ".git"), { recursive: true });
    expect(workingRepoArtifactBase(repoRoot)).toBe(path.join(repoRoot, ".lfbridge"));
  });

  it("falls back to .lfbridge/ when the repo has no sync repo at all", () => {
    const loose = path.join(tmp, "loose-repo");
    fs.mkdirSync(path.join(loose, ".git"), { recursive: true });
    expect(workingRepoArtifactBase(loose)).toBe(path.join(loose, ".lfbridge"));
  });
});

describe("the confidentiality fence: a private repo never lands in the company repo", () => {
  const PRIVATE = "https://github.com/BryanStarbuck/Bryan_Arindom.git";

  it("admits the company's own org and refuses every other org or no remote", () => {
    expect(syncRepoAdmitsRemote(syncRepo, REMOTE)).toBe(true);
    expect(syncRepoAdmitsRemote(syncRepo, "git@github.com:act3ai/other.git")).toBe(true); // case-insensitive
    expect(syncRepoAdmitsRemote(syncRepo, PRIVATE)).toBe(false);
    expect(syncRepoAdmitsRemote(syncRepo, null)).toBe(false);
  });

  it("the personal sync repo admits any repo", () => {
    const personal = path.join(tmp, "personal_large_files_bridge");
    fs.mkdirSync(path.join(personal, ".git"), { recursive: true });
    expect(syncRepoAdmitsRemote(personal, PRIVATE)).toBe(true);
  });

  it("a stale company marker on a PRIVATE repo is refused at write time → the repo's own .lfbridge/", () => {
    const priv = path.join(tmp, "Bryan_Arindom");
    gitRepo(priv, PRIVATE);
    setSyncRepoMarker(priv, syncRepo, PRIVATE); // as an older build / a peer's observed fallback could have
    expect(workingRepoArtifactBase(priv)).toBe(path.join(priv, ".lfbridge"));
  });

  it("the migration never moves a private repo's .lfbridge/ into the company repo", () => {
    const priv = path.join(tmp, "Bryan_Arindom");
    gitRepo(priv, PRIVATE);
    setSyncRepoMarker(priv, syncRepo, PRIVATE);
    const src = path.join(priv, ".lfbridge", "bank_statements", "s.pdf.ocr");
    write(src, "text: secret\n");
    expect(migrateRepoLfbridgeToSync(priv)).toBeNull();
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readdirSync(path.join(syncRepo, "repos"))).not.toContain(expect.stringMatching(/arindom/i));
  });
});

describe("the already-done probe", () => {
  it("finds an artifact that lives in the sync repo (never a false MISSING)", () => {
    write(path.join(mirrorDir, "site/img/a.jpg.ocr"), "status: done\ntext: ''\n");
    write(path.join(mirrorDir, "site/img/a.jpg.ai_description"), "x");
    expect(analysisOutputsFromDisk(repoRoot, "site/img/a.jpg")).toEqual(expect.arrayContaining(["ocr", "description"]));
  });
});

describe("the Category-B state copy", () => {
  it("never copies content artifacts from the mirror down into Local Storage", () => {
    write(path.join(mirrorDir, "site/img/a.jpg.ocr"), "status: done\n");
    write(path.join(mirrorDir, "files/site/img/a.jpg.yaml"), "path: site/img/a.jpg\n");
    reconcileFromSyncRepo(repoRoot);
    expect(fs.existsSync(path.join(repoStateDir(repoRoot), "site/img/a.jpg.ocr"))).toBe(false);
  });
});

describe("migrateRepoLfbridgeToSync", () => {
  it("moves every artifact, keeps the newer of two differing copies, and leaves no .lfbridge/ behind", () => {
    const lfb = path.join(repoRoot, ".lfbridge");
    write(path.join(lfb, "site/img/new.jpg.ocr"), "moved");
    write(path.join(lfb, "videos/v.mp4.transcription"), "tx");
    write(path.join(lfb, "same.png.ai_description"), "same");
    write(path.join(mirrorDir, "same.png.ai_description"), "same");
    // an older copy here, a newer one in the mirror → the mirror's survives
    write(path.join(lfb, "old.png.ocr"), "old");
    write(path.join(mirrorDir, "old.png.ocr"), "newer");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(lfb, "old.png.ocr"), past, past);
    // a newer copy here, an older one in the mirror → ours replaces it
    write(path.join(mirrorDir, "fresh.png.ocr"), "stale");
    fs.utimesSync(path.join(mirrorDir, "fresh.png.ocr"), past, past);
    write(path.join(lfb, "fresh.png.ocr"), "fresh");

    const r = migrateRepoLfbridgeToSync(repoRoot)!;
    expect(r).not.toBeNull();
    expect(r.moved).toBe(2);
    expect(r.deduped).toBe(1);
    expect(r.keptDest).toBe(1);
    expect(r.replaced).toBe(1);
    expect(r.failed).toBe(0);
    expect(fs.readFileSync(path.join(mirrorDir, "site/img/new.jpg.ocr"), "utf8")).toBe("moved");
    expect(fs.readFileSync(path.join(mirrorDir, "videos/v.mp4.transcription"), "utf8")).toBe("tx");
    expect(fs.readFileSync(path.join(mirrorDir, "old.png.ocr"), "utf8")).toBe("newer");
    expect(fs.readFileSync(path.join(mirrorDir, "fresh.png.ocr"), "utf8")).toBe("fresh");
    expect(fs.existsSync(lfb)).toBe(false);
    // the removal still has to be committed — latched so a restart cannot lose it
    expect(fs.existsSync(path.join(repoStateDir(repoRoot), LFBRIDGE_MOVED_LATCH))).toBe(true);
  });

  it("leaves anything that is not an artifact where it is", () => {
    const lfb = path.join(repoRoot, ".lfbridge");
    write(path.join(lfb, "a.jpg.ocr"), "x");
    write(path.join(lfb, "notes.txt"), "user file");
    migrateRepoLfbridgeToSync(repoRoot);
    expect(fs.readFileSync(path.join(lfb, "notes.txt"), "utf8")).toBe("user file");
    expect(fs.existsSync(path.join(lfb, "a.jpg.ocr"))).toBe(false);
  });

  it("does nothing when the sync repo is not cloned here", () => {
    fs.rmSync(path.join(syncRepo, ".git"), { recursive: true });
    write(path.join(repoRoot, ".lfbridge/a.jpg.ocr"), "x");
    expect(migrateRepoLfbridgeToSync(repoRoot)).toBeNull();
    expect(fs.existsSync(path.join(repoRoot, ".lfbridge/a.jpg.ocr"))).toBe(true);
  });
});
