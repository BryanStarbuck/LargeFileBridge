// A CID THIS COMPUTER PROVED WRONG MUST NOT COME BACK.
//
// `mergeManifests` breaks a same-timestamp CID disagreement with a total order on the value. That is right
// for two IPFS add profiles of one file — both spellings are valid, so any deterministic winner converges —
// and arbitrary for a wrapper-DIRECTORY CID beside the file CID it contains, where one side is simply wrong.
//
// On charlie-kirk it came up wrapper. A pull healed 8 entries and pulled the bytes down; the backbone
// reconcile a minute later handed all 8 wrapper CIDs straight back, and the pull-down count went from 8 to
// 16 with every file on disk and pinned under the healed CID. Weeks of attempts were undone the same way.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeManifests } from "../storage/manifest-merge.js";
import type { Manifest } from "@lfb/shared";

// The real pair off charlie-kirk. NOTE the sort order: the wrapper is LOWER, so the tie-break preferred it.
const WRAPPER = "bafybeicwjeormngkewi5z5kvt53n7fmt7gxnaxnelpga7rq6oh6tb7mszq";
const FILE = "bafybeidib6akamtlpj5h73jtxdnkxskon6w46clhx3726t3xy47uypop64";
const REL = "videos/2045871393611395289_00001.mp3";
const STAMP = "2026-04-20T12:33:32.577Z";

const manifest = (cid: string, pinnedBy: string[]): Manifest =>
  ({
    schema_version: 1,
    files: [{ path: REL, cid, size: 1029637, sha256: null, modified_at: STAMP, pinned_by: pinnedBy }],
  }) as Manifest;

const cidOf = (m: Manifest): string | null | undefined => m.files.find((f) => f.path === REL)?.cid;

describe("mergeManifests — a disproved CID cannot win", () => {
  it("keeps the healed FILE cid when the wire hands the wrapper back", async () => {
    const merged = mergeManifests(manifest(FILE, ["pc-10"]), manifest(WRAPPER, ["bryan-mac-pro"]), "pc-10", {
      incomingIsWire: true,
      supersededCid: (c) => (c === WRAPPER ? FILE : null),
    });
    expect(cidOf(merged)).toBe(FILE);
  });

  it("documents WHY that guard is needed — without it the wrapper wins the tie", async () => {
    const merged = mergeManifests(manifest(FILE, ["pc-10"]), manifest(WRAPPER, ["bryan-mac-pro"]), "pc-10", {
      incomingIsWire: true,
    });
    expect(cidOf(merged)).toBe(WRAPPER); // sorts lower — the behaviour that reverted every heal
  });

  it("corrects an entry the wire never mentioned, so the fix is PUBLISHED and not just held", async () => {
    // The mirror write is a merge too. A correction that only survived where the peer also sent the path
    // would never reach the computer still holding the bad CID.
    const merged = mergeManifests(manifest(WRAPPER, ["pc-10"]), { schema_version: 1, unit: "repo", files: [] } as Manifest, "pc-10", {
      incomingIsWire: true,
      supersededCid: (c) => (c === WRAPPER ? FILE : null),
    });
    expect(cidOf(merged)).toBe(FILE);
  });

  it("leaves a CID it knows nothing about exactly as the tie-break decided", async () => {
    const merged = mergeManifests(manifest(FILE, ["pc-10"]), manifest(WRAPPER, ["bryan-mac-pro"]), "pc-10", {
      incomingIsWire: true,
      supersededCid: () => null,
    });
    expect(cidOf(merged)).toBe(WRAPPER);
  });
});

// ── the other half: the heal has to WRITE DOWN what it proved ──────────────────────────────────────────
const FOLDER = "superseded-fixture";
let tmp: string;
let repoRoot: string;

vi.mock("../ipfs/ipfs.service.js", async (orig) => {
  const actual = await orig<typeof import("../ipfs/ipfs.service.js")>();
  return {
    ...actual,
    listPins: vi.fn(async () => []),
    health: vi.fn(async () => "ok" as const),
    resolveFileCid: vi.fn(async (cid: string) => cid),
    hasProvider: vi.fn(async () => true),
    pinAdd: vi.fn(async () => undefined),
    catToFile: vi.fn(async () => undefined),
  };
});

beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-superseded-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  process.env.LFB_LOG_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => {
  delete process.env.LFB_STATE_DIR;
  delete process.env.LFB_LOG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("a wrapper-CID heal records what it proved", () => {
  it("lets the NEXT wire merge reject the wrapper CID the peer still holds", async () => {
    const units = await import("../store-model/units.service.js");
    await units.updateRepoConfig(FOLDER, (c) => ({
      ...c,
      repo: { ...c.repo, name: FOLDER, path: repoRoot, remote: null },
      pinned: true,
    }));
    const { writeRepoTrackingManifest } = await import("./manifest.service.js");
    writeRepoTrackingManifest(repoRoot, manifest(WRAPPER, ["bryan-mac-pro"]));

    const ipfs = await import("../ipfs/ipfs.service.js");
    vi.mocked(ipfs.listPins).mockResolvedValue([]);
    vi.mocked(ipfs.hasProvider).mockResolvedValue(true);
    vi.mocked(ipfs.pinAdd).mockResolvedValue(undefined);
    vi.mocked(ipfs.catToFile).mockImplementation(async (cid: string) => cid);
    vi.mocked(ipfs.resolveFileCid).mockImplementation(async (c: string) => (c === WRAPPER ? FILE : c));

    const { pullMissing } = await import("./pin.service.js");
    expect((await pullMissing(repoRoot, [REL])).pulled).toBe(1);

    const { supersededCid } = await import("./superseded-cids.service.js");
    expect(supersededCid(WRAPPER)).toBe(FILE);

    // And now the reconcile that used to revert it cannot.
    const merged = mergeManifests(manifest(FILE, ["pc-10"]), manifest(WRAPPER, ["bryan-mac-pro"]), "pc-10", {
      incomingIsWire: true,
      supersededCid,
    });
    expect(cidOf(merged)).toBe(FILE);
  });
});
