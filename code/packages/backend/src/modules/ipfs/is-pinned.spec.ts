// `isPinned` answers ONE question about ONE CID — it must not walk the whole pinset to do it, and it must
// keep the ROOT-PINS-ONLY contract `listPins` states (ipfs.mdx §1).
//
// Two failures are pinned here:
//   • COST. It enumerated the entire pinset for a single-CID question, so the pin toggle paid a full
//     reconcile per click — on the large pinsets this product produces, that is the difference between an
//     instant control and one that appears hung.
//   • CORRECTNESS OF THE CHEAP PATH. `pin/ls?arg=<cid>&type=all` also reports a block held INDIRECTLY under
//     someone else's recursive root. Counting that as pinned would make the toggle report "pinned ✓" the
//     instant the user turned it OFF, whenever those bytes also sit inside another pinned DAG. And a
//     NEGATIVE from the direct query is never definitive, because pin/ls is base-sensitive (§5.1) — only a
//     canonical compare against the roots listing can rule a pin out.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({ ipfs: { api_addr: "/ip4/127.0.0.1/tcp/5001" } }),
}));
vi.mock("../events/state-events.service.js", () => ({ bumpTopicThrottled: () => {}, IPFS_TOPIC: "ipfs" }));

const { isPinned } = await import("./ipfs.service.js");

// The SAME block in both encodings — a CIDv0 dag-pb pin and the CIDv1 base32 spelling of its multihash.
const V0 = "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR";
const V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

let fetchMock: ReturnType<typeof vi.fn>;
const jsonRes = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const notPinned = (): Response => new Response(`Error: path '…' is not pinned`, { status: 500 });
/** The streamed NDJSON shape `listPins` reads for a full enumeration. */
const pinStream = (cids: string[]): Response =>
  new Response(cids.map((c) => JSON.stringify({ Cid: c })).join("\n") + "\n", { status: 200 });

const urlOf = (call: unknown[]): string => String(call[0]);
const singleCidQueries = (): string[] =>
  fetchMock.mock.calls.map(urlOf).filter((u) => u.includes("/pin/ls") && u.includes("arg="));
const fullEnumerations = (): string[] =>
  fetchMock.mock.calls.map(urlOf).filter((u) => u.includes("/pin/ls") && !u.includes("arg="));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("isPinned", () => {
  it("answers from ONE single-CID query when the pin is there — never enumerating the pinset", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ Keys: { [V1]: { Type: "recursive" } } }));
    await expect(isPinned(V1)).resolves.toBe(true);
    expect(singleCidQueries()).toHaveLength(1);
    expect(fullEnumerations()).toHaveLength(0); // the whole point
  });

  it("does NOT count a block held only INDIRECTLY under someone else's recursive root", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ Keys: { [V1]: { Type: `indirect through ${V0}` } } }));
    // Falls through to the canonical roots listing, which does not carry it either.
    fetchMock.mockResolvedValueOnce(pinStream([])); // recursive
    fetchMock.mockResolvedValueOnce(pinStream([])); // direct
    await expect(isPinned(V1)).resolves.toBe(false);
  });

  it("falls back to a CANONICAL enumeration when the direct query says no — pin/ls is base-sensitive", async () => {
    // The block IS pinned, as `Qm…`. Asked for its `bafy…` spelling, Kubo answers "not pinned".
    fetchMock.mockResolvedValueOnce(notPinned());
    fetchMock.mockResolvedValueOnce(pinStream([V0])); // recursive roots, in the OTHER base
    fetchMock.mockResolvedValueOnce(pinStream([]));
    await expect(isPinned(V1)).resolves.toBe(true);
    expect(fullEnumerations().length).toBeGreaterThan(0); // the negative was not taken at face value
  });

  it("is false — never a throw — when the node genuinely does not hold it", async () => {
    fetchMock.mockResolvedValueOnce(notPinned());
    fetchMock.mockResolvedValueOnce(pinStream([]));
    fetchMock.mockResolvedValueOnce(pinStream([]));
    await expect(isPinned(V1)).resolves.toBe(false);
  });

  it("is false — never a throw — when the daemon is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    await expect(isPinned(V1)).resolves.toBe(false);
  });
});
