// Long-running IPFS ops must not be killed by a control-call wall clock, and must never report a pin
// that did not land (knowledge/ipfs.mdx §3; the "pin add failed … This operation was aborted" fault).
// These lock the DAEMON-FREE contract of ipfs.service's `pinAdd` / `listPins` by stubbing global fetch:
//   • a pin that takes far longer than the 15s control-call cap still SUCCEEDS (no total-duration cap),
//   • an aborted/stalled pin is RETRIED, and its success is only claimed on Kubo's {"Pins":[…]} record,
//   • a mid-stream Kubo error (a {"Message":…} trailer after a 200) is a FAILURE, not a silent pin,
//   • pin/ls parses both the streamed NDJSON shape and the legacy {"Keys":{…}} blob, and a mid-stream
//     failure THROWS rather than returning a partial list that would read as "these are all the pins".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Retry BACKOFF is real seconds in production; collapse it here so exercising the retry path costs ms.
// The retry COUNT and behaviour under test are untouched by this.
process.env.LFB_IPFS_RETRY_MS = "5";

vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({ ipfs: { api_addr: "/ip4/127.0.0.1/tcp/5001" } }),
}));
vi.mock("../events/state-events.service.js", () => ({ bumpTopicThrottled: () => {}, IPFS_TOPIC: "ipfs" }));

const { pinAdd, listPins } = await import("./ipfs.service.js");

const CID = "bafybeig2h7dvxz6eq7af2p4ope57dqh4j5ulfvninyyou5xkx46s4hyqsi";

/** A Response whose body streams the given NDJSON lines (optionally with a delay before each). */
function ndjsonResponse(lines: string[], perLineDelayMs = 0): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of lines) {
        if (perLineDelayMs) await new Promise((r) => setTimeout(r, perLineDelayMs));
        controller.enqueue(new TextEncoder().encode(line + "\n"));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const abortError = (): Error => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pinAdd — long pins survive, failed pins are never claimed", () => {
  it("succeeds on a pin that streams progress for far longer than the old 15s control-call cap", async () => {
    // Progress records spread over time: the old fixed timeout aborted exactly this shape mid-transfer.
    fetchMock.mockResolvedValueOnce(
      ndjsonResponse(
        ['{"Progress":1}', '{"Progress":2}', '{"Progress":3}', `{"Pins":["${CID}"]}`],
        5,
      ),
    );
    await expect(pinAdd(CID)).resolves.toBeUndefined();
    // progress=true is what makes liveness measurable at all — assert we ask for it.
    expect(String(fetchMock.mock.calls[0][0])).toContain("progress=true");
  });

  it("retries an abort and reports success only after a real {\"Pins\":…} confirmation", async () => {
    fetchMock
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(ndjsonResponse([`{"Pins":["${CID}"]}`]));
    await expect(pinAdd(CID)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("THROWS when every attempt aborts — an aborted pin must never be recorded as pinned", async () => {
    fetchMock.mockRejectedValue(abortError());
    await expect(pinAdd(CID)).rejects.toThrow(/abort/i);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // it was retried, not accepted
  });

  it("THROWS on a mid-stream Kubo error trailer (HTTP 200 with no pin established)", async () => {
    fetchMock.mockResolvedValue(ndjsonResponse(['{"Progress":1}', '{"Message":"merkledag: not found"}']));
    await expect(pinAdd(CID)).rejects.toThrow(/not found/);
  });

  it("THROWS when the stream ends with no confirmation record at all", async () => {
    fetchMock.mockResolvedValue(ndjsonResponse(['{"Progress":7}']));
    await expect(pinAdd(CID)).rejects.toThrow(/no confirmation/);
  });

  // ── DISCOVERY IS NOT IDLENESS (the 2026-08-05 false-abort burst) ────────────────────────────────────
  // Kubo answers pin/add immediately, then walks the DHT and dials the provider — emitting {"Progress":0}
  // once a second the whole way. The idle deadline was being spent on that phase, so 13 interactive pulls
  // were hung up on at exactly 2:00 and again at 4:00 while the daemon logged `context canceled` for each.
  it("does NOT abort during provider discovery — a run of {\"Progress\":0} is not a stall", async () => {
    // Idle budget 40ms, discovery budget 5s. Zero-progress heartbeats stretch well past the idle budget;
    // the pin must still land. With the old guard (one window, and Progress:0 counted as movement) the
    // clock would be the 40ms one and this aborts.
    fetchMock.mockResolvedValueOnce(
      ndjsonResponse(['{"Progress":0}', '{"Progress":0}', '{"Progress":0}', '{"Progress":0}', `{"Pins":["${CID}"]}`], 25),
    );
    await expect(pinAdd(CID, { stallMs: 40, discoveryMs: 5_000, attempts: 1 })).resolves.toBeUndefined();
  });

  it("still aborts a discovery that produces nothing at all within its own budget", async () => {
    // The watchdog must not become toothless: a provider that is never found still has to fail. Either
    // wording is correct — whether the abort interrupts the read or the body ends first is a race.
    fetchMock.mockResolvedValue(ndjsonResponse(['{"Progress":0}'], 400));
    await expect(pinAdd(CID, { stallMs: 30, discoveryMs: 60, attempts: 1 })).rejects.toThrow(/abort|stalled/i);
  });

  it("RETRIES a watchdog failure that surfaced as our own 'stalled' message, not just a raw abort", async () => {
    // The retry ladder tested `/abort/i` alone, so the more informative wording silently skipped every
    // retry — the exact failure mode behind "pin add failed … after 2 attempt(s)" on a 3-attempt budget.
    fetchMock
      .mockResolvedValueOnce(ndjsonResponse(['{"Progress":0}'], 120))
      .mockResolvedValueOnce(ndjsonResponse([`{"Pins":["${CID}"]}`]));
    await expect(pinAdd(CID, { stallMs: 20, discoveryMs: 40, attempts: 3 })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never lets a tight interactive idle budget shorten the discovery window", async () => {
    // pullMissing passes a 2-min idle budget; discovery is clamped to at least that, never below it.
    fetchMock.mockResolvedValueOnce(
      ndjsonResponse(['{"Progress":0}', '{"Progress":0}', `{"Pins":["${CID}"]}`], 25),
    );
    await expect(pinAdd(CID, { stallMs: 5_000, discoveryMs: 10, attempts: 1 })).resolves.toBeUndefined();
  });
});

describe("listPins — enumeration is streamed, and a failure is never a partial list", () => {
  it("parses the streamed NDJSON shape", async () => {
    fetchMock
      .mockResolvedValueOnce(ndjsonResponse([`{"Cid":"${CID}","Type":"recursive"}`]))
      .mockResolvedValueOnce(ndjsonResponse([]));
    expect(await listPins()).toEqual([{ cid: CID, type: "recursive" }]);
  });

  it("still parses the legacy non-streaming {\"Keys\":{…}} blob", async () => {
    fetchMock
      .mockResolvedValueOnce(ndjsonResponse([`{"Keys":{"${CID}":{"Type":"recursive"}}}`]))
      .mockResolvedValueOnce(ndjsonResponse([]));
    expect(await listPins()).toEqual([{ cid: CID, type: "recursive" }]);
  });

  it("THROWS on a mid-enumeration failure instead of returning what it managed to read", async () => {
    fetchMock.mockResolvedValue(
      ndjsonResponse([`{"Cid":"${CID}","Type":"recursive"}`, '{"Message":"datastore closed"}']),
    );
    await expect(listPins()).rejects.toThrow(/pin ls \(recursive\) failed/);
  });

  it("retries an aborted enumeration before giving up", async () => {
    fetchMock
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(ndjsonResponse([`{"Cid":"${CID}","Type":"recursive"}`]))
      .mockResolvedValueOnce(ndjsonResponse([]));
    expect(await listPins()).toEqual([{ cid: CID, type: "recursive" }]);
  });
});
