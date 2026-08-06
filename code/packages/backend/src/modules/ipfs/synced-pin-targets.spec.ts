// AN UNPIN THAT THE ENGINE UNDOES IS NOT AN UNPIN (ipfs.mdx §3, pin_process.mdx §4).
//
// The pins table's Pin icon and the row kebab's "Unpin from this computer" both ran a bare `ipfs pin rm`.
// For a file still decided Add-to-IPFS that is only half an answer: the very next pin pass sees a `sync`
// file missing from the pinset, treats it as a lost pin, and adds+pins it straight back. The user's click
// reverted itself inside a cycle, the toast said "Unpinned", and nothing anywhere said why the pin was
// back. `syncedPinTargets()` is the lookup that lets the unpin path clear the decision with the pin —
// the same meaning "Remove from IPFS" already carries in the file menu (menus.mdx §5.3) and on Full paths
// (full_paths.mdx §3.5).
//
// The second half of the contract is what it must NOT return. Recording `ipfs: false` for an UNDECIDED
// file would freeze it out of every future pin pass — a far bigger answer than the one the user gave, and
// exactly the "git-ignoring a file quietly opted it out of syncing" defect decisions.mdx §1 exists to kill.
import { describe, it, expect, vi } from "vitest";

// The same block in two encodings: a manifest may record the `bafy…` spelling of a pin that arrives as
// `Qm…`, so the lookup has to canonicalize both sides (knowledge/ipfs.mdx §5.1) or it silently finds nothing.
const V0 = "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR";
const V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const OTHER = "bafybeibxm2nsadl3fnkz2heezregvqjq3zqvqfvxhqjkyxvxhqjkyxvxhq";

interface Repo {
  files: Array<{ path: string; cid: string | null }>;
  decisions: Record<string, string>;
}
const repos: Record<string, Repo> = {};

vi.mock("../store-model/units.service.js", () => ({
  listRepoFolders: () => Object.keys(repos),
  getRepoConfig: (folder: string) => ({ repo: { path: `/repos/${folder}`, name: folder }, decisions: repos[folder].decisions }),
  getRepoManifest: (folder: string) => ({
    files: repos[folder].files.map((f) => ({ ...f, size: 1, pinned_by: [] })),
  }),
  getRepoStatus: () => ({ last_scan_at: null }),
  repoIdFromPath: (p: string) => p,
}));
vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({ ipfs: { api_addr: "/ip4/127.0.0.1/tcp/5001", public_gateway: false }, computer: { label: "laptop" } }),
}));
vi.mock("../events/state-events.service.js", () => ({ bumpTopicThrottled: () => {}, IPFS_TOPIC: "ipfs" }));
vi.mock("../storage/tracking.service.js", () => ({ analysisOutputs: () => [] }));
vi.mock("./foreign-pin.service.js", () => ({ foreignPinByCanonicalCid: () => null }));

const { syncedPinTargets } = await import("./ipfs-page.service.js");

function withRepo(r: Repo): void {
  for (const k of Object.keys(repos)) delete repos[k];
  repos.movies = r;
}

describe("syncedPinTargets — what an unpin would be undone by", () => {
  it("finds the decided file behind the CID, so the unpin can clear the decision too", () => {
    withRepo({ files: [{ path: "trailer.mp4", cid: V1 }], decisions: { "trailer.mp4": "sync" } });
    expect(syncedPinTargets(V1)).toEqual([{ folder: "movies", rel: "trailer.mp4", name: "trailer.mp4" }]);
  });

  it("matches CANONICALLY — a Qm-encoded pin of a bafy-recorded file is the same block", () => {
    withRepo({ files: [{ path: "trailer.mp4", cid: V1 }], decisions: { "trailer.mp4": "sync" } });
    // A raw-string compare here finds nothing, the decision survives, and the pin comes back next pass.
    expect(syncedPinTargets(V0)).toHaveLength(1);
  });

  it("returns NOTHING for an undecided file — an unpin must not record 'never sync this'", () => {
    withRepo({ files: [{ path: "trailer.mp4", cid: V1 }], decisions: {} });
    expect(syncedPinTargets(V1)).toEqual([]);
  });

  it("returns NOTHING for a file already decided ignore — there is no decision left to clear", () => {
    withRepo({ files: [{ path: "trailer.mp4", cid: V1 }], decisions: { "trailer.mp4": "ignore" } });
    expect(syncedPinTargets(V1)).toEqual([]);
  });

  it("returns NOTHING for a CID no manifest carries — an untracked pin has no decision behind it", () => {
    withRepo({ files: [{ path: "trailer.mp4", cid: V1 }], decisions: { "trailer.mp4": "sync" } });
    expect(syncedPinTargets(OTHER)).toEqual([]);
  });

  it("finds EVERY decided copy — the same bytes tracked in two repos re-pin from either one", () => {
    for (const k of Object.keys(repos)) delete repos[k];
    repos.movies = { files: [{ path: "trailer.mp4", cid: V1 }], decisions: { "trailer.mp4": "sync" } };
    repos.archive = { files: [{ path: "old/trailer.mp4", cid: V0 }], decisions: { "old/trailer.mp4": "sync" } };
    expect(syncedPinTargets(V1).map((t) => t.folder).sort()).toEqual(["archive", "movies"]);
  });
});
