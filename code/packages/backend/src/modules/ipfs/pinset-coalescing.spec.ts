// `pin/ls` is a MINUTES-to-HOURS call on this product's pinsets, not a control call — log.log carries real
// enumerations at 1,234,025 ms, 3,172,380 ms and 7,269,167 ms (over two hours). Eight call sites reached
// `listPins()` with no coalescing, so a pin pass, a scan and one load of the IPFS page each started their
// OWN two-hour enumeration against the same daemon; the stall lines arrive in pairs and triples sharing a
// single millisecond, which is three of them aborting together. That is the "the app hangs" report.
//
// What is locked here: one enumeration serves every concurrent asker, a repeat ask inside the TTL is free,
// a FAILURE is never cached, and our own pin/unpin drops the memo so a read after a write is never stale.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({ ipfs: { api_addr: "/ip4/127.0.0.1/tcp/5001" } }),
}));
vi.mock("../events/state-events.service.js", () => ({ bumpTopicThrottled: () => {}, IPFS_TOPIC: "ipfs" }));

const { listPins, pinAdd, pinRm, invalidatePinsetCache } = await import("./ipfs.service.js");

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

let fetchMock: ReturnType<typeof vi.fn>;
// A FACTORY, not one Response: a body may only be read once, so every fetch needs its own.
const pinStream = (cids: string[]) => () =>
  Promise.resolve(new Response(cids.map((c) => JSON.stringify({ Cid: c })).join("\n") + "\n", { status: 200 }));
/** One `listPins()` costs TWO enumerations — the `recursive` and `direct` types. */
const enumerations = (): number =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes("/pin/ls")).length;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  invalidatePinsetCache();
});
afterEach(() => vi.unstubAllGlobals());

describe("listPins — one enumeration, however many askers", () => {
  it("coalesces concurrent callers into a SINGLE enumeration", async () => {
    fetchMock.mockImplementation(pinStream([CID]));
    const [a, b, c] = await Promise.all([listPins(), listPins(), listPins()]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(enumerations()).toBe(2); // recursive + direct, ONCE — not 6
  });

  it("serves a repeat ask from the memo instead of re-enumerating", async () => {
    fetchMock.mockImplementation(pinStream([CID]));
    await listPins();
    const after = enumerations();
    await listPins();
    expect(enumerations()).toBe(after); // no new RPC at all
  });

  it("NEVER caches a failure — the next caller retries for real", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("boom", { status: 500 })));
    await expect(listPins()).rejects.toThrow();
    const afterFailure = enumerations();
    fetchMock.mockImplementation(pinStream([CID]));
    await expect(listPins()).resolves.toHaveLength(1);
    expect(enumerations()).toBeGreaterThan(afterFailure);
  });

  it("folds OUR OWN unpin into the memo — no stale answer, and no re-enumeration", async () => {
    fetchMock.mockImplementation(pinStream([CID]));
    await expect(listPins()).resolves.toHaveLength(1);
    const afterFirst = enumerations();

    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 }))); // pin/rm reply
    await pinRm(CID);

    // The memo now reflects our write WITHOUT paying for the enumeration again. Discarding it would be
    // correct too, but a pin pass unpins in bursts and each one would throw away a minutes-long call.
    await expect(listPins()).resolves.toHaveLength(0);
    expect(enumerations()).toBe(afterFirst);
  });

  it("folds OUR OWN pin in under the CANONICAL key, so a v0/v1 spelling cannot duplicate it", async () => {
    // The daemon listed the block as CIDv0; we pin the same block by its CIDv1 spelling. `pin ls` is
    // base-sensitive (ipfs.mdx §5.1), so a raw string compare would leave BOTH in the memo.
    const V0 = "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR";
    const V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    fetchMock.mockImplementation(pinStream([V0]));
    await expect(listPins()).resolves.toHaveLength(1);

    // pin/add?progress=true streams NDJSON and confirms with a {"Pins":[…]} record.
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ Pins: [V1] }) + "\n", { status: 200 })),
    );
    await pinAdd(V1);
    await expect(listPins()).resolves.toHaveLength(1); // ONE block, not two spellings of it
  });
});
