// The on-disk repair for the 2026-08-04 Windows-separator defect (repo__list_syns.mdx §6.1). Written
// against real state files and a real working tree, because the whole point of this migration is what it
// does to BYTES, not to a data structure.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { migratePosixPaths } from "./migrate-posix-paths.js";

let tmp: string;
let state: string;
let repo: string;

const unitDir = () => path.join(state, "pin", "r", "all");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-posix-repair-"));
  state = path.join(tmp, "state");
  repo = path.join(tmp, "all");
  fs.mkdirSync(unitDir(), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(unitDir(), "config.yaml"),
    ["repo:", `  path: ${repo}`, "decisions:", String.raw`  jfk\videos\clip.mp4: sync`].join("\n"),
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeManifest(body: string[]): void {
  fs.writeFileSync(path.join(unitDir(), "manifest.yaml"), body.join("\n"));
}

describe("migratePosixPaths — the state files", () => {
  it("rewrites `\\` manifest keys and FOLDS the two spellings of one file", () => {
    writeManifest([
      "schema_version: 1",
      "unit: repo",
      "files:",
      String.raw`  - path: jfk\videos\clip.mp4`,
      "    cid: bafywindows",
      "    size: 10",
      "    pinned_by:",
      "      - lenovo-laptop",
      "  - path: jfk/videos/clip.mp4",
      "    cid: null",
      "    size: 10",
      "    pinned_by:",
      "      - mac-pro",
    ]);
    migratePosixPaths(state);

    const raw = fs.readFileSync(path.join(unitDir(), "manifest.yaml"), "utf8");
    expect(raw).not.toContain("\\");
    const doc = parse(raw);
    expect(doc.files).toHaveLength(1);
    expect(doc.files[0].path).toBe("jfk/videos/clip.mp4");
    expect(doc.files[0].cid).toBe("bafywindows"); // the entry that knows more survives
    expect(doc.files[0].pinned_by).toEqual(["lenovo-laptop", "mac-pro"]); // claims union — never dropped
  });

  it("leaves the COMPUTER unit alone — its entries are absolute paths, where `C:\\…` is real", () => {
    const dir = path.join(state, "pin", "r", "computerish");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "manifest.yaml");
    const body = [
      "schema_version: 1",
      "unit: computer",
      "files:",
      String.raw`  - path: C:\Users\bryan\clip.mp4`,
      "    cid: bafy1",
      "    size: 10",
      "    pinned_by: []",
    ].join("\n");
    fs.writeFileSync(file, body);
    migratePosixPaths(state);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
  });

  it("rewrites the unit config's decision keys", () => {
    migratePosixPaths(state);
    const doc = parse(fs.readFileSync(path.join(unitDir(), "config.yaml"), "utf8"));
    expect(doc.decisions).toEqual({ "jfk/videos/clip.mp4": "sync" });
  });

  it("is idempotent — a second run changes nothing", () => {
    migratePosixPaths(state);
    const after = fs.readFileSync(path.join(unitDir(), "config.yaml"), "utf8");
    migratePosixPaths(state);
    expect(fs.readFileSync(path.join(unitDir(), "config.yaml"), "utf8")).toBe(after);
  });
});

describe("migratePosixPaths — the stray files a pull materialized", () => {
  it("moves `jfk\\videos\\clip.mp4` at the repo root to jfk/videos/clip.mp4", () => {
    const stray = path.join(repo, String.raw`jfk\videos\clip.mp4`);
    fs.writeFileSync(stray, "BYTES");
    migratePosixPaths(state);

    expect(fs.existsSync(stray)).toBe(false);
    expect(fs.readFileSync(path.join(repo, "jfk", "videos", "clip.mp4"), "utf8")).toBe("BYTES");
  });

  it("REFUSES to overwrite: a stray whose proper path is taken is left exactly where it is", () => {
    const stray = path.join(repo, String.raw`jfk\videos\clip.mp4`);
    fs.writeFileSync(stray, "STRAY");
    fs.mkdirSync(path.join(repo, "jfk", "videos"), { recursive: true });
    fs.writeFileSync(path.join(repo, "jfk", "videos", "clip.mp4"), "REAL");
    migratePosixPaths(state);

    expect(fs.readFileSync(stray, "utf8")).toBe("STRAY");
    expect(fs.readFileSync(path.join(repo, "jfk", "videos", "clip.mp4"), "utf8")).toBe("REAL");
  });

  it("relocates the flat sidecar a `\\` key produced (git cannot check that name out on Windows)", () => {
    const filesDir = path.join(state, "repos", "abc123", "files");
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, String.raw`jfk\videos\clip.mp4.yaml`), "file:\n  path: x\n");
    migratePosixPaths(state);

    expect(fs.existsSync(path.join(filesDir, "jfk", "videos", "clip.mp4.yaml"))).toBe(true);
    expect(fs.readdirSync(filesDir).some((n) => n.includes("\\"))).toBe(false);
  });

  it("MERGES a forked sidecar history instead of dropping either half", () => {
    const filesDir = path.join(state, "repos", "abc123", "files");
    fs.mkdirSync(path.join(filesDir, "jfk", "videos"), { recursive: true });
    // The stray holds one computer's events; the proper sidecar holds another's — the fork, verbatim.
    fs.writeFileSync(
      path.join(filesDir, String.raw`jfk\videos\clip.mp4.yaml`),
      [
        "file:",
        String.raw`  path: jfk\videos\clip.mp4`,
        "  events:",
        "    - at: 2026-08-04T04:52:56.235Z",
        "      kind: pull",
        "      on_device: rafin-macbook-pro",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(filesDir, "jfk", "videos", "clip.mp4.yaml"),
      [
        "file:",
        "  path: jfk/videos/clip.mp4",
        "  size: 45006721",
        "  events:",
        "    - at: 2026-08-03T12:59:41.817Z",
        "      kind: pull",
        "      on_device: lenovo-laptop-ug0k96ca",
      ].join("\n"),
    );
    migratePosixPaths(state);

    expect(fs.readdirSync(filesDir).some((n) => n.includes("\\"))).toBe(false);
    const doc = parse(fs.readFileSync(path.join(filesDir, "jfk", "videos", "clip.mp4.yaml"), "utf8"));
    expect(doc.file.events.map((e: { on_device: string }) => e.on_device)).toEqual([
      "lenovo-laptop-ug0k96ca", // sorted by `at` — the history reads in order again
      "rafin-macbook-pro",
    ]);
    // The survivor's identity fields win: the stray's `path` was the corruption and its size was null.
    expect(doc.file.path).toBe("jfk/videos/clip.mp4");
    expect(doc.file.size).toBe(45006721);
  });

  it("repairs the COMMITTED sync-repo mirror too — a `\\` name cannot be checked out on Windows", () => {
    const repoState = path.join(state, "repos", "abc123");
    const mirror = path.join(tmp, "sync-repo", "repos", "uid123");
    fs.mkdirSync(path.join(mirror, "files"), { recursive: true });
    fs.mkdirSync(repoState, { recursive: true });
    fs.writeFileSync(path.join(repoState, ".sync-repo"), `${path.join(tmp, "sync-repo")}\nuid123\n`);
    fs.writeFileSync(path.join(mirror, "files", String.raw`a\b.mp4.yaml`), "file:\n  path: x\n");
    migratePosixPaths(state);

    expect(fs.existsSync(path.join(mirror, "files", "a", "b.mp4.yaml"))).toBe(true);
    expect(fs.readdirSync(path.join(mirror, "files")).some((n) => n.includes("\\"))).toBe(false);
  });

  it("runs ONCE — a stray that appears after the marker is not touched again", () => {
    migratePosixPaths(state);
    const stray = path.join(repo, String.raw`later\clip.mp4`);
    fs.writeFileSync(stray, "BYTES");
    migratePosixPaths(state);
    expect(fs.existsSync(stray)).toBe(true);
  });
});
