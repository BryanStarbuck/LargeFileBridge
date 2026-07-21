// Wrapper-directory CID resolution (knowledge/ipfs.mdx §5.1). This locks the fix for the loudest fault in
// the app: ~2,900 `ipfs cat <CID> -> "this dag node is a directory"` failures in two days, one per file per
// sync pass, forever — and the file never syncing.
//
// The cause: Kubo's HTTP `add` treats a SLASHED multipart filename as a directory tree, wrapping the file in
// one UnixFS directory PER PATH SEGMENT and returning the WRAPPER-dir CID. A real failing record from this
// machine resolved as
//   bafybeih2ohwgd… (dir) → bryan/ → BGit/ → Bryan_git/ → charlie-kirk/ → videos/ → 2011947043674034660.mp3
// `ipfs cat` on any of those directory nodes can never succeed. `addFile` now sends only the basename, so no
// NEW record can be wrong; `resolveFileCid` is what rescues the ones already written — it walks the wrapper
// chain down to the file, and the pin/pull paths write the resolved CID back so the dead one is dropped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveFileCid } from "./ipfs.service.js";

const DIRS = ["bafy-root", "bafy-bryan", "bafy-bgit", "bafy-videos"];
const FILE = "bafkreifile";

/** Stub the Kubo RPC: `files/stat` reports the node type, `ls` lists one child per wrapper level. */
function stubDaemon(tree: Record<string, Array<{ Name: string; Hash: string }>>) {
  const json = (body: unknown) => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url);
    const arg = u.searchParams.get("arg")!;
    if (u.pathname.endsWith("/files/stat")) {
      const cid = arg.replace("/ipfs/", "");
      return json({ Type: tree[cid] ? "directory" : "file" });
    }
    if (u.pathname.endsWith("/ls")) return json({ Objects: [{ Links: tree[arg] ?? [] }] });
    throw new Error(`unexpected RPC ${u.pathname}`);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveFileCid (wrapper-directory CIDs)", () => {
  it("walks a multi-level wrapper chain down to the file CID", async () => {
    stubDaemon({
      [DIRS[0]!]: [{ Name: "bryan", Hash: DIRS[1]! }],
      [DIRS[1]!]: [{ Name: "BGit", Hash: DIRS[2]! }],
      [DIRS[2]!]: [{ Name: "videos", Hash: DIRS[3]! }],
      [DIRS[3]!]: [{ Name: "clip.mp4", Hash: FILE }],
    });
    expect(await resolveFileCid(DIRS[0]!, "clip.mp4")).toBe(FILE);
  });

  it("leaves a plain file CID untouched (the common case pays only one metadata call)", async () => {
    stubDaemon({});
    expect(await resolveFileCid(FILE, "clip.mp4")).toBe(FILE);
  });

  it("picks the child matching the target basename when a directory holds several", async () => {
    stubDaemon({ [DIRS[0]!]: [{ Name: "other.mp4", Hash: "bafy-other" }, { Name: "clip.mp4", Hash: FILE }] });
    expect(await resolveFileCid(DIRS[0]!, "clip.mp4")).toBe(FILE);
  });

  it("throws — never guesses — when a directory has many children and none matches the name", async () => {
    stubDaemon({ [DIRS[0]!]: [{ Name: "a.mp4", Hash: "bafy-a" }, { Name: "b.mp4", Hash: "bafy-b" }] });
    await expect(resolveFileCid(DIRS[0]!, "clip.mp4")).rejects.toThrow(/cannot resolve it to a single file/);
  });
});
