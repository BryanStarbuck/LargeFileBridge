// A SLOW daemon is not a DEAD one (ipfs.service.ts `health`).
//
// `rpc` aborts a control call at RPC_TIMEOUT_MS. A daemon that is alive and answering blows through that
// cap routinely — a stale pooled keep-alive socket it already dropped, a GC sweep, a `pin ls` over a large
// pinset. `runUnitPin` (pin.service.ts) returns the instant health is not "ok", BEFORE it examines a single
// file, and stamps a persistent red "IPFS node unreachable" on the unit. So one timed-out probe used to
// abandon a whole pin pass over a node with two dozen peers that answers instantly.
//
// The split pinned here: a TIMEOUT is re-probed on a fresh socket before we call the node gone; a REFUSAL
// (or any other protocol-level failure) is conclusive and reported at once — `waitForStopped` polls for
// exactly that and must not be made to wait out a retry for every stop the app performs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({ ipfs: { api_addr: "/ip4/127.0.0.1/tcp/5001" } }),
}));
vi.mock("../events/state-events.service.js", () => ({ bumpTopicThrottled: () => {}, IPFS_TOPIC: "ipfs" }));

const { health, noteDaemonStopped } = await import("./ipfs.service.js");

const ok = (): Response => new Response(JSON.stringify({ ID: "12D3Koo" }), { status: 200 });
const aborted = (): never => {
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  throw e;
};

beforeEach(() => noteDaemonStopped()); // clears the consecutive-probe run between tests
afterEach(() => vi.unstubAllGlobals());

describe("health() — timeout vs. refusal", () => {
  it("re-probes a TIMED-OUT probe and reports ok when the node answers the second one", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++calls === 1 ? aborted() : ok())),
    );
    expect(await health()).toBe("ok");
    expect(calls).toBe(2); // the blip was retried, not believed
  });

  it("still says unreachable when EVERY probe times out", async () => {
    const fetchMock = vi.fn(async () => aborted());
    vi.stubGlobal("fetch", fetchMock);
    expect(await health()).toBe("unreachable");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("does NOT retry a refused connection — a stop the app is waiting on must be seen at once", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await health()).toBe("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves CONCURRENT callers from one probe — a wedged daemon must not queue up every poller", async () => {
    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return ok();
    });
    vi.stubGlobal("fetch", fetchMock);
    const all = await Promise.all([health(), health(), health(), health()]);
    expect(all).toEqual(["ok", "ok", "ok", "ok"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache: the probe after a transition sees it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    expect(await health()).toBe("ok");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await health()).toBe("unreachable");
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    expect(await health()).toBe("ok");
  });
});
