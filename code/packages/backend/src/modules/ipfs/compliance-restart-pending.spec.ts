// THE GAP OUTLIVES THE CALL THAT OPENED IT (ipfs.mdx §3.1.1).
//
// `enforceCompliance()` returns `restartRequired` to its one caller, which toasts it once. But the node
// card is re-read every few seconds by pages that live on the screen for hours, and it is composed from
// `nodePosture()` — which reads the CONFIG FILE. So the moment that toast fades, every surface in the app
// goes back to painting "Only your content ✓" over a daemon that is, right now, still a circuit-relay v2
// server and a DHT server for strangers, and will stay one until it restarts.
//
// `compliancePendingRestart()` is what the card reads so it can keep saying so. Three halves are pinned here:
//   • It is SET by a write and NOT set by a no-op — an already-compliant node must never be told to restart
//     for nothing (a false alarm is how a real one stops being read).
//   • It CLEARS when the daemon is observed down. That is the honest signal: whatever we wrote is on disk,
//     and a daemon that is not running will read it when it starts. It is also the only observation point
//     that catches a restart done OUTSIDE the app (a terminal, a reboot, launchd) — without it the card
//     would sit amber forever on a node the user already fixed.
//   • But ONE failed probe is not "down". `rpc` aborts at RPC_TIMEOUT_MS and a daemon mid-GC or mid-pin-pass
//     can miss that deadline while it is still running, still un-adopted. Clearing on that blip is
//     PERMANENT — nothing re-sets the flag once the config already matches — so the green card would come
//     back over a node that is still a relay. Confirmation takes consecutive probes; the app's own stops
//     don't wait for them (`noteDaemonStopped`).
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

const { enforceCompliance, resetComplianceThrottle, compliancePendingRestart, noteDaemonStopped, health } =
  await import("./ipfs.service.js");

/** Kubo's DEFAULT posture: relaying strangers' traffic and serving their DHT queries. */
const NON_COMPLIANT: Record<string, unknown> = {
  "Provide.Strategy": "all",
  "Addresses.Gateway": "/ip4/127.0.0.1/tcp/8080",
  "Swarm.RelayService.Enabled": true,
  "Routing.Type": "auto",
};
const COMPLIANT: Record<string, unknown> = {
  "Provide.Strategy": "pinned",
  "Addresses.Gateway": "/ip4/127.0.0.1/tcp/8080",
  "Swarm.RelayService.Enabled": false,
  "Routing.Type": "autoclient",
};

/** Stand in for the `config` RPC over a mutable in-memory node config. */
function nodeWith(values: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const state = { ...values };
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    const args = u.searchParams.getAll("arg");
    if (!u.pathname.endsWith("/config")) return new Response("{}", { status: 200 });
    const [key, value] = args;
    if (value !== undefined) {
      state[key!] = u.searchParams.get("json") === "true" ? JSON.parse(value) : value;
      return new Response(JSON.stringify({ Key: key, Value: state[key!] }), { status: 200 });
    }
    if (!(key! in state)) return new Response(`${key} not found`, { status: 500 });
    return new Response(JSON.stringify({ Value: state[key!] }), { status: 200 });
  });
}

beforeEach(() => resetComplianceThrottle());
afterEach(() => vi.unstubAllGlobals());

describe("compliancePendingRestart", () => {
  it("is false before anything has been written", () => {
    expect(compliancePendingRestart()).toBe(false);
  });

  it("stays SET after the enforcement call returns — the card is read long after the toast", async () => {
    vi.stubGlobal("fetch", nodeWith(NON_COMPLIANT));
    await enforceCompliance({ force: true });
    expect(compliancePendingRestart()).toBe(true);
  });

  it("is NOT set when nothing needed changing — no restart nag for an already-compliant node", async () => {
    vi.stubGlobal("fetch", nodeWith(COMPLIANT));
    await enforceCompliance({ force: true });
    expect(compliancePendingRestart()).toBe(false);
  });

  it("clears when the daemon is CONFIRMED down — the next start reads what we already wrote", async () => {
    vi.stubGlobal("fetch", nodeWith(NON_COMPLIANT));
    await enforceCompliance({ force: true });
    expect(compliancePendingRestart()).toBe(true);

    // The daemon stops outside the app (a terminal, a reboot, launchd). Every status poll comes through
    // health(), so this is where that restart is noticed.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await health()).toBe("unreachable");
    expect(await health()).toBe("unreachable");
    expect(compliancePendingRestart()).toBe(false);
  });

  it("a SINGLE failed probe does not clear it — a busy daemon is not a stopped one", async () => {
    vi.stubGlobal("fetch", nodeWith(NON_COMPLIANT));
    await enforceCompliance({ force: true });

    // One RPC misses the 15s cap (a GC sweep, a big pin pass) and then the node answers again. It is the
    // SAME un-adopted process throughout; clearing here would be permanent, and permanently green.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await health()).toBe("unreachable");
    expect(compliancePendingRestart()).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ID: "12D3Koo" }), { status: 200 })));
    expect(await health()).toBe("ok");
    expect(compliancePendingRestart()).toBe(true);

    // …and the recovery reset the run, so the next lone blip doesn't finish the count either.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await health()).toBe("unreachable");
    expect(compliancePendingRestart()).toBe(true);
  });

  it("a stop the APP watched clears it at once — it does not wait for a second probe", async () => {
    vi.stubGlobal("fetch", nodeWith(NON_COMPLIANT));
    await enforceCompliance({ force: true });

    // `waitForStopped` returns on its FIRST failing probe, so without this the app's own restart would
    // leave the flag set and nag for a restart it just performed.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await health()).toBe("unreachable");
    noteDaemonStopped();
    expect(compliancePendingRestart()).toBe(false);
  });

  it("a healthy probe does NOT clear it — only the daemon going away can", async () => {
    vi.stubGlobal("fetch", nodeWith(NON_COMPLIANT));
    await enforceCompliance({ force: true });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ID: "12D3Koo" }), { status: 200 })));
    expect(await health()).toBe("ok");
    expect(compliancePendingRestart()).toBe(true); // still the same un-adopted process
  });
});
