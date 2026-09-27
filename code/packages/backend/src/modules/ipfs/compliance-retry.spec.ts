// A FAILED COMPLIANCE ENFORCEMENT IS RETRIED, NOT WAITED OUT UNTIL THE NEXT BOOT (error catalog #21).
//
// Boot runs `enforceCompliance({ force: true })` while the daemon is often still too busy to answer a
// `config` RPC — `Could not enforce compliance: This operation was aborted`. That run had already stamped the
// throttle, the pin pass never reaches enforcement when pinning is off, so the charter's no-public-gateway /
// no-relay default could go unasserted until the next boot. The enforcement must arm its own retry and keep
// at it until one run completes.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.LFB_COMPLIANCE_RETRY_MS = "5";

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

const { enforceCompliance, resetComplianceThrottle, complianceRetryPending } = await import("./ipfs.service.js");
const { log } = await import("../../shared/logging.js");

/** A Kubo `config` RPC over an in-memory node in its DEFAULT (non-compliant) posture. */
function defaultNode(writes: string[]): (url: string) => Promise<Response> {
  const state: Record<string, unknown> = {
    "Provide.Strategy": "all",
    "Addresses.Gateway": "/ip4/127.0.0.1/tcp/8080",
    "Swarm.RelayService.Enabled": true,
    "Routing.Type": "auto",
  };
  return async (url: string) => {
    const u = new URL(url);
    const [key, value] = u.searchParams.getAll("arg");
    if (value !== undefined) {
      writes.push(key!);
      state[key!] = u.searchParams.get("json") === "true" ? JSON.parse(value) : value;
      return new Response(JSON.stringify({ Key: key, Value: state[key!] }), { status: 200 });
    }
    return new Response(JSON.stringify({ Value: state[key!] }), { status: 200 });
  };
}

const abort = (): Error => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

beforeEach(() => resetComplianceThrottle());
afterEach(() => {
  resetComplianceThrottle();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("enforceCompliance — a transient abort arms a retry that finishes the job", () => {
  it("retries after the daemon was too busy, and asserts the policy once it answers", async () => {
    const writes: string[] = [];
    const node = defaultNode(writes);
    let busy = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (busy) throw abort();
        return node(url);
      }),
    );
    const warn = vi.spyOn(log, "warn");

    const first = await enforceCompliance({ force: true });
    expect(first.changed).toEqual([]);
    expect(complianceRetryPending()).toBe(true); // not abandoned until the next boot
    expect(warn.mock.calls.some(([, m]) => /Could not enforce compliance.*retrying/.test(m))).toBe(true);

    busy = false; // the daemon has woken up
    await vi.waitFor(() => expect(writes).toContain("Swarm.RelayService.Enabled"), { timeout: 2_000 });
    expect(writes).toContain("Routing.Type");
    expect(writes).toContain("Provide.Strategy");
    await vi.waitFor(() => expect(complianceRetryPending()).toBe(false));
  });

  it("keeps retrying through a streak of failures with ONE warn, not one per attempt", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        throw abort();
      }),
    );
    const warn = vi.spyOn(log, "warn");
    await enforceCompliance({ force: true });
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
    expect(complianceRetryPending()).toBe(true);
    expect(warn.mock.calls.filter(([, m]) => /Could not enforce compliance/.test(m))).toHaveLength(1);
  });

  it("arms nothing when enforcement completes", async () => {
    vi.stubGlobal("fetch", vi.fn(defaultNode([])));
    await enforceCompliance({ force: true });
    expect(complianceRetryPending()).toBe(false);
  });
});
