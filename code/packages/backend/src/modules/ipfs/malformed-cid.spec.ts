// A CORRUPT MANIFEST ENTRY IS NOT AN IPFS FAULT (ipfs.service.ts `looksLikeCid` / `pinAdd`).
//
// Kubo answers a garbage CID with `500 invalid path "…": path does not have enough components`. That
// failure is PERMANENT — no peer, no retry and no amount of waiting can turn a non-CID into one — but it
// used to travel the same road as a transient one: an RPC to the daemon, then an ERROR line in the fault
// trail. And because the pin pass re-reads the manifest every cycle, the same dead entry produced the
// same ERROR every 15 minutes, forever, over a perfectly healthy node (hundreds of lines a day in a live
// error.err). Refuse it at the door, name the real fault, and never spend an RPC on it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({ ipfs: { api_addr: "/ip4/127.0.0.1/tcp/5001" } }),
}));
vi.mock("../events/state-events.service.js", () => ({ bumpTopicThrottled: () => {}, IPFS_TOPIC: "ipfs" }));

const { pinAdd, looksLikeCid } = await import("./ipfs.service.js");

const REAL_V1 = "bafybeigsg4vedybnoctpfxn3xwg2jw3rfhtug4rzmrlv5zjq2t3t5il4a"; // 59 chars, base32
const REAL_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"; // 46 chars, base58

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.restoreAllMocks());

describe("looksLikeCid", () => {
  it("accepts the CID forms the product actually stores", () => {
    expect(looksLikeCid(REAL_V1)).toBe(true);
    expect(looksLikeCid(REAL_V0)).toBe(true);
    expect(looksLikeCid(` ${REAL_V1} `)).toBe(true); // a stray newline out of YAML is not corruption
  });

  it("rejects the strings that were reaching the daemon", () => {
    for (const junk of ["bafywanted", "bafy9-1", "bafyone", "", "   ", "bafy/../etc/passwd"]) {
      expect(looksLikeCid(junk)).toBe(false);
    }
  });
});

describe("pinAdd", () => {
  it("refuses a malformed CID WITHOUT calling the daemon, and says the manifest is the fault", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(pinAdd("bafywanted")).rejects.toThrow(/malformed CID/);
    expect(fetchMock).not.toHaveBeenCalled(); // no RPC spent, no 500 in the fault trail
  });

  it("still pins a well-formed CID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ Pins: [REAL_V1] }), { status: 200 })),
    );
    await expect(pinAdd(REAL_V1)).resolves.toBeUndefined();
  });
});
