// A PIN IS NOT A PROMISE THAT ANYONE CAN FETCH IT.
//
// Every vector in `nodePosture()` answers the charter's defensive question — "are we serving other
// people's content or traffic?" — and every one of them is satisfied by a node that is switched off. The
// question the product exists to answer went unmeasured: a file pinned on this computer has to be
// fetchable BY THE USER, from their other computers, over the internet.
//
// That is not implied by a successful pin. `ipfs add` succeeds identically on a node no peer on earth can
// dial. Verified live on Bryan_Tower 2026-09-10: the node announces its WAN address as a UPnP/NAT-PMP
// lease — `/ip4/50.35.54.162/tcp/32862`, a mapped port, not the configured 4001. Lose the lease, land
// behind CGNAT, or have the router drop UPnP on a firmware update and the daemon keeps running, keeps
// pinning, keeps rendering "Only your content ✓" — while every other computer silently stops being able
// to fetch anything at all. Pins succeed; the sync is dead. Nothing on any surface said so.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rpcJson = vi.hoisted(() => ({ value: null as unknown }));
const rpcThrows = vi.hoisted(() => ({ value: false }));

vi.mock("../../shared/logging.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logError: vi.fn(),
}));

// Stub `fetch` — `rpc()` is module-private, and the point of this spec is the classifier, not HTTP.
beforeEach(() => {
  rpcThrows.value = false;
  vi.stubGlobal("fetch", async () => {
    if (rpcThrows.value) throw new Error("connect ECONNREFUSED 127.0.0.1:5001");
    return new Response(JSON.stringify(rpcJson.value), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const SELF = "12D3KooWGJgvtXA4aSbm3v7ahSFdXfAy1WpeE4Cvo7WW5zuN5jDe";
const reach = async () => (await import("./ipfs.service.js")).nodeReach();
const withAddrs = (addrs: string[]) => {
  rpcJson.value = { ID: SELF, Addresses: addrs.map((a) => `${a}/p2p/${SELF}`) };
};

describe("nodeReach — can our OTHER computers actually fetch what we pinned?", () => {
  it("reports REACHABLE for the real announced set (a WAN address behind a UPnP port map)", async () => {
    // Copied from this machine's live `ipfs id` — the shape that actually works end to end.
    withAddrs([
      "/ip4/127.0.0.1/tcp/4001",
      "/ip4/192.168.254.108/tcp/4001",
      "/ip4/192.168.50.253/udp/4001/quic-v1",
      "/ip6/::1/tcp/4001",
      "/ip4/50.35.54.162/tcp/32862",
    ]);
    const r = await reach();
    expect(r.externallyReachable).toBe(true);
    expect(r.relayOnly).toBe(false);
    expect(r.directAddrs).toEqual(["/ip4/50.35.54.162/tcp/32862"]);
  });

  it("reports NOT reachable when only LAN + loopback are announced — the silent-island state", async () => {
    withAddrs([
      "/ip4/127.0.0.1/tcp/4001",
      "/ip4/192.168.254.108/tcp/4001",
      "/ip4/10.0.0.5/udp/4001/quic-v1",
      "/ip4/172.16.4.2/tcp/4001",
      "/ip6/::1/tcp/4001",
      "/ip6/fe80::1/tcp/4001",
      "/ip6/fd12:3456::1/tcp/4001",
    ]);
    const r = await reach();
    expect(r.externallyReachable).toBe(false);
    expect(r.directAddrs).toEqual([]);
  });

  // CGNAT is the case that makes UPnP a liar: the router happily grants a mapping to an address that is
  // itself un-routable, so the node announces something that looks public and is not.
  it("treats a CGNAT address (100.64/10) as NOT public", async () => {
    withAddrs(["/ip4/127.0.0.1/tcp/4001", "/ip4/100.72.13.9/tcp/32862"]);
    expect((await reach()).externallyReachable).toBe(false);
  });

  it("counts a relay address as reachable, but flags it as relay-only", async () => {
    withAddrs([
      "/ip4/192.168.1.10/tcp/4001",
      "/ip4/147.75.87.27/tcp/4001/p2p/QmRelay/p2p-circuit",
    ]);
    const r = await reach();
    expect(r.externallyReachable).toBe(true);
    expect(r.relayOnly).toBe(true);
    expect(r.directAddrs).toEqual([]);
    expect(r.relayAddrs).toHaveLength(1);
  });

  it("counts the AutoTLS `libp2p.direct` DNS address as a public way in", async () => {
    withAddrs([
      "/ip4/127.0.0.1/tcp/4001",
      "/dns4/50-35-54-162.k51qzi5uqu5dil380ou1kf5ml1a2h766me049ezm3rj00hqw80tdauia56m5it.libp2p.direct/tcp/32862/tls/ws",
    ]);
    expect((await reach()).externallyReachable).toBe(true);
  });

  // Kubo announces the same host once per transport. Reporting "4 public addresses" for what is one way
  // in would make the card's detail line nonsense.
  it("de-duplicates one host announced across four transports", async () => {
    withAddrs([
      "/ip4/50.35.54.162/tcp/32862",
      "/ip4/50.35.54.162/udp/32862/quic-v1",
      "/ip4/50.35.54.162/udp/32862/quic-v1/webtransport",
      "/ip4/50.35.54.162/udp/32862/webrtc-direct",
    ]);
    expect((await reach()).directAddrs).toHaveLength(4); // distinct transports, same host — all real
    withAddrs(["/ip4/50.35.54.162/tcp/32862", "/ip4/50.35.54.162/tcp/32862"]);
    expect((await reach()).directAddrs).toHaveLength(1); // the identical repeat collapses
  });

  // The same never-claim-what-you-did-not-verify rule nodePosture() follows, pointed outward: a node we
  // cannot read is one we certainly cannot prove the fleet can dial.
  it("claims NOTHING when the daemon is unreachable", async () => {
    rpcThrows.value = true;
    const r = await reach();
    expect(r.externallyReachable).toBe(false);
    expect(r.relayOnly).toBe(false);
    expect(r.directAddrs).toEqual([]);
  });

  it("survives a node that returns no Addresses at all", async () => {
    rpcJson.value = { ID: SELF };
    expect((await reach()).externallyReachable).toBe(false);
  });
});
