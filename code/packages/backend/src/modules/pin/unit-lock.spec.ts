// A REPO UNIT'S PIN PASS MUST NOT RACE ITSELF (unit-lock.ts).
//
// Storage units got a lock (git-lock.ts, storage_company.mdx §11.3); repo units never did, while three
// callers reach `pinRepoFolder` for one folder — the decision-triggered targeted pin, a manual "Pin now",
// and the 15-minute background pass. `passInFlight` guards whole passes against each other, never a pass
// against a route call. Because `runUnitPin` writes the unit manifest WHOLESALE from a snapshot taken at
// entry, two overlapping runs drop each other's newly-added CIDs and re-upload those files next pass.
import { describe, it, expect } from "vitest";
import { withUnitLock, activeUnitLockCount } from "./unit-lock.js";

const settle = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("withUnitLock — one pass at a time per unit", () => {
  it("serializes overlapping passes on the SAME unit", async () => {
    const order: string[] = [];
    const pass = (tag: string) => async (): Promise<string> => {
      order.push(`${tag}:read`);
      await settle();
      order.push(`${tag}:write`); // the wholesale manifest write — must never interleave with another read
      return tag;
    };
    const [a, b] = await Promise.all([
      withUnitLock("repo:demo", pass("bg")),
      withUnitLock("repo:demo", pass("click")),
    ]);
    expect(order).toEqual(["bg:read", "bg:write", "click:read", "click:write"]);
    expect([a, b]).toEqual(["bg", "click"]);
  });

  it("lets DIFFERENT units run concurrently — the pass fans out across repos by design", async () => {
    const order: string[] = [];
    await Promise.all([
      withUnitLock("repo:a", async () => {
        order.push("a:in");
        await settle();
        order.push("a:out");
      }),
      withUnitLock("repo:b", async () => {
        order.push("b:in");
        await settle();
        order.push("b:out");
      }),
    ]);
    expect(order.slice(0, 2).sort()).toEqual(["a:in", "b:in"]); // both entered before either left
  });

  it("gives every caller its OWN counts — a scoped pin must never be collapsed into another's", async () => {
    // The reason this is a FIFO chain and not git-lock.ts's coalescing lock: a paths-scoped run carries the
    // user's selection, so returning a queued run's result would report counts for files they never picked.
    const results = await Promise.all([
      withUnitLock("repo:demo", async () => ({ added: 1 })),
      withUnitLock("repo:demo", async () => ({ added: 2 })),
      withUnitLock("repo:demo", async () => ({ added: 3 })),
    ]);
    expect(results).toEqual([{ added: 1 }, { added: 2 }, { added: 3 }]);
  });

  it("a failed pass does not poison its successor, and the failure still reaches its own caller", async () => {
    const failed = withUnitLock("repo:demo", async () => {
      throw new Error("pin ls failed");
    });
    const next = withUnitLock("repo:demo", async () => "ran anyway");
    await expect(failed).rejects.toThrow("pin ls failed");
    expect(await next).toBe("ran anyway");
  });

  it("drops the chain once drained, so an idle repo costs nothing", async () => {
    await withUnitLock("repo:transient", async () => undefined);
    await settle(); // the tail's cleanup is a microtask behind the caller's resolution
    expect(activeUnitLockCount()).toBe(0);
  });
});
