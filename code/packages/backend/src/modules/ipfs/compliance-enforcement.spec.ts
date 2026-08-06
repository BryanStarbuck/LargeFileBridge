// ENFORCING COMPLIANCE CHANGES THE FILE, NOT THE RUNNING NODE (charter; ipfs.mdx §3.2).
//
// All four charter vectors — `Provide.Strategy` (what we announce), `Addresses.Gateway` (what we serve),
// `Swarm.RelayService.Enabled` (whose traffic we carry) and `Routing.Type` (whose DHT queries we answer) —
// are read by Kubo when the DAEMON INITIALIZES and never re-read. So a successful `enforceCompliance()`
// leaves the live process exactly as non-compliant as it was, while `nodePosture()` (which reads the
// CONFIG) immediately reports a fully green card. That is the same silence-is-safety failure §3.2 exists to
// kill, one axis over: this time the reassuring ✓ is about a node that is, right now, still a circuit-relay
// v2 server and a DHT server for strangers. The enforcement must SAY it needs a restart.
//
// The second contract here is the THROTTLE. Enforcement is a reconciliation of four settings that change
// only when a human or another tool edits them, and it costs 5–7 RPC round trips — but `runUnitPin` called
// it once PER UNIT, so a machine with 30 repos and 3 storages spent ~200 RPCs every 15-minute pass
// re-asserting settings it had already asserted. A user-pressed Fix must never be silenced by that throttle.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({
    ipfs: {
      api_addr: "/ip4/127.0.0.1/tcp/5001",
      reprovide_strategy: "pinned",
      gateway_addr: "/ip4/127.0.0.1/tcp/8080",
      public_gateway: false,
    },
  }),
}));
vi.mock("../events/state-events.service.js", () => ({ bumpTopicThrottled: () => {}, IPFS_TOPIC: "ipfs" }));

const { enforceCompliance, resetComplianceThrottle } = await import("./ipfs.service.js");

/** The config values a node in Kubo's DEFAULT (non-compliant) posture reports. */
const NON_COMPLIANT: Record<string, unknown> = {
  "Provide.Strategy": "all", // announces everything it holds, including third-party cache
  "Addresses.Gateway": "/ip4/127.0.0.1/tcp/8080", // already loopback — isolate the traffic vectors
  "Swarm.RelayService.Enabled": true, // relays strangers' connections
  "Routing.Type": "auto", // becomes a DHT server for strangers
};

let fetchMock: ReturnType<typeof vi.fn>;
/** Every `config` key this run WROTE, in order. */
let writes: string[];

/** Stand in for the `config` RPC over a mutable in-memory node config. */
function nodeWith(values: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const state = { ...values };
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    const args = u.searchParams.getAll("arg");
    if (!u.pathname.endsWith("/config")) return new Response("{}", { status: 200 });
    const [key, value] = args;
    if (value !== undefined) {
      writes.push(key!);
      state[key!] = u.searchParams.get("json") === "true" ? JSON.parse(value) : value;
      return new Response(JSON.stringify({ Key: key, Value: state[key!] }), { status: 200 });
    }
    if (!(key! in state)) return new Response(`${key} not found`, { status: 500 });
    return new Response(JSON.stringify({ Value: state[key!] }), { status: 200 });
  });
}

beforeEach(() => {
  writes = [];
  resetComplianceThrottle();
});
afterEach(() => vi.unstubAllGlobals());

describe("enforceCompliance — a written setting is not a live setting", () => {
  it("reports restartRequired, and NAMES every key it wrote, on a default Kubo node", async () => {
    fetchMock = nodeWith(NON_COMPLIANT);
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await enforceCompliance({ force: true });

    expect(outcome.ran).toBe(true);
    // Both TRAFFIC vectors default to ON in Kubo, so an untouched node must have both rewritten — the
    // charter bans carrying other people's traffic outright.
    expect(outcome.changed).toContain("Swarm.RelayService.Enabled");
    expect(outcome.changed).toContain("Routing.Type");
    expect(outcome.changed).toContain("Provide.Strategy"); // and the CONTENT vector
    // The load-bearing claim: the daemon has NOT adopted any of it yet.
    expect(outcome.restartRequired).toBe(true);
  });

  it("claims no restart when the node was already compliant — silence must not be alarming either", async () => {
    fetchMock = nodeWith({
      "Provide.Strategy": "pinned",
      "Addresses.Gateway": "/ip4/127.0.0.1/tcp/8080",
      "Swarm.RelayService.Enabled": false,
      "Routing.Type": "autoclient",
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await enforceCompliance({ force: true });

    expect(outcome.changed).toEqual([]);
    expect(outcome.restartRequired).toBe(false);
    expect(writes).toEqual([]); // read-only when there is nothing to fix
  });

  it("writes the MODERN Provide.Strategy, never the deprecated Reprovider block", async () => {
    // Re-creating `Reprovider` makes Kubo 0.42+ FATAL on the next start (ipfs_ui.mdx §14) — i.e. enforcing
    // "compliance" would re-arm the exact crash the feature exists to fix.
    fetchMock = nodeWith(NON_COMPLIANT);
    vi.stubGlobal("fetch", fetchMock);
    await enforceCompliance({ force: true });
    expect(writes).toContain("Provide.Strategy");
    expect(writes).not.toContain("Reprovider.Strategy");
  });
});

describe("enforceCompliance — throttle", () => {
  it("skips a background re-assertion inside the window, touching the node not at all", async () => {
    fetchMock = nodeWith(NON_COMPLIANT);
    vi.stubGlobal("fetch", fetchMock);

    await enforceCompliance(); // the first pin unit of a pass
    const afterFirst = fetchMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await enforceCompliance(); // every OTHER unit in the same pass
    expect(second.ran).toBe(false);
    expect(second.changed).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(afterFirst); // not one extra RPC
  });

  it("never silences an explicit user Fix — force bypasses the window", async () => {
    fetchMock = nodeWith(NON_COMPLIANT);
    vi.stubGlobal("fetch", fetchMock);

    await enforceCompliance();
    const afterFirst = fetchMock.mock.calls.length;

    const forced = await enforceCompliance({ force: true });
    expect(forced.ran).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
