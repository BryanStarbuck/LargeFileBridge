// CID canonicalization tests (knowledge/ipfs.mdx §5.1). This locks the load-bearing fact behind the
// "the CLI says pinned, the app says not pinned" defect: `ipfs pin ls` is base-SENSITIVE, so the SAME block
// pinned as CIDv0 (`Qm…`) is invisible to a raw-string compare against its CIDv1 (`bafy…`) form. Every
// pinset membership test canonicalizes both sides via `canonicalCid`; if this conversion drifts, the app
// silently goes blind to pins again.
//
// The fixture is the real disconnect that motivated the fix: a Charlie-Kirk video pinned on the CLI as
//   QmTo4HtjkqvEMCvAUMDo6eP6FwroAp8r2btv1mqGSwyFFa   (CIDv0)
// whose canonical CIDv1 base32 form is
//   bafybeicrbyzvjc2vuqs3t4dyj6jtawuidxxccowacmqg3kau3z7hdjd7yu
// (verified with `ipfs cid base32`). NOTE the two are the SAME block, two encodings — which canonicalCid
// bridges. It does NOT (and must not claim to) bridge a DIFFERENT DAG profile (raw-leaves / cid-version),
// which is a different multihash entirely (that gap is handled by re-hashing in contentPinnedCid).
import { describe, it, expect } from "vitest";
import { canonicalCid } from "./ipfs.service.js";

const V0 = "QmTo4HtjkqvEMCvAUMDo6eP6FwroAp8r2btv1mqGSwyFFa";
const V1 = "bafybeicrbyzvjc2vuqs3t4dyj6jtawuidxxccowacmqg3kau3z7hdjd7yu";

describe("canonicalCid (knowledge/ipfs.mdx §5.1)", () => {
  it("converts a CIDv0 to its CIDv1 base32 form (same block)", () => {
    expect(canonicalCid(V0)).toBe(V1);
  });

  it("is idempotent — a CIDv1 is already canonical", () => {
    expect(canonicalCid(V1)).toBe(V1);
  });

  it("a v0 pin and its v1-form manifest CID compare EQUAL after canonicalization", () => {
    // The exact test the pinset membership does: `pinset.has(canonicalCid(cid))`.
    const pinset = new Set([V0].map(canonicalCid)); // pinset arrives base-sensitive (as `Qm…`)
    expect(pinset.has(canonicalCid(V1))).toBe(true); // manifest recorded the `bafy…` form → still matches
  });

  it("a DIFFERENT DAG profile of the same bytes is NOT bridged (documented limitation)", () => {
    // `bafybeigoytoir7…` is the SAME video's bytes under --cid-version=1 (raw-leaves) — a different
    // multihash, so canonicalCid must NOT conflate it with the no-raw-leaves pin.
    const rawLeaves = "bafybeigoytoir7tr2wgtj5xbqthw5fe4zh2brh6dn6z3oj4335ie4g2oxe";
    expect(canonicalCid(rawLeaves)).not.toBe(V1);
  });

  it("returns unrecognized input unchanged (best-effort, never throws)", () => {
    expect(canonicalCid("")).toBe("");
    expect(canonicalCid("not-a-cid")).toBe("not-a-cid");
    expect(canonicalCid("bafkreiabc")).toBe("bafkreiabc"); // already v1 → passthrough
  });
});
