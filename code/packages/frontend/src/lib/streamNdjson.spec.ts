// THE 401 BACKSTOP THE STREAM PATH WAS MISSING.
//
// Every axios call already recovers from a 401 by forcing one shared re-mint and retrying
// (api/axios.ts `registerAuthBridge`). Streams did not — and streams are the requests most exposed to it,
// because a Bearer that `getFreshToken()` believed was good can still be rejected if it lapsed between
// attach and verify (the backend needed longer than TOKEN_HARD_FLOOR_S to reach the check) or the clocks
// disagree. error.err carried both halves of the resulting loop: `[auth] Token verification failed (GET
// /events/stream): "exp" claim timestamp check failed` on the server, `stream failed: HTTP 401` on the
// client, over and over, because each reconnect re-sent the SAME cached token.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getFreshToken = vi.fn<() => Promise<string | null>>();
const refreshTokenOnce = vi.fn<() => Promise<string | null>>();
vi.mock("../api/authCore.js", () => ({
  getFreshToken: () => getFreshToken(),
  refreshTokenOnce: () => refreshTokenOnce(),
}));
vi.mock("./clientLog.js", () => ({ clientLog: { warn: () => {}, error: () => {} } }));

const { streamNdjson } = await import("./streamNdjson.js");

const ndjson = (lines: string[]): Response =>
  new Response(lines.join("\n") + "\n", { status: 200 });
const unauthorized = (): Response => new Response("", { status: 401 });
const sentTokens = (f: ReturnType<typeof vi.fn>): string[] =>
  f.mock.calls.map((c) => {
    const h = (c[1] as RequestInit).headers as Record<string, string>;
    return h.Authorization ?? "";
  });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  getFreshToken.mockReset().mockResolvedValue("stale-token");
  refreshTokenOnce.mockReset().mockResolvedValue("fresh-token");
});
afterEach(() => vi.unstubAllGlobals());

describe("streamNdjson — recovering from a 401", () => {
  it("forces ONE re-mint and retries with the NEW Bearer", async () => {
    fetchMock.mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ndjson(['{"type":"hello"}']));
    const seen: unknown[] = [];
    await streamNdjson("/events/stream", { onEvent: (e) => seen.push(e) });

    expect(refreshTokenOnce).toHaveBeenCalledTimes(1);
    expect(sentTokens(fetchMock)).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    expect(seen).toEqual([{ type: "hello" }]); // and the stream actually delivered
  });

  it("retries exactly ONCE — a 401 that survives a fresh mint is a real answer, not a spin", async () => {
    fetchMock.mockResolvedValue(unauthorized());
    await expect(streamNdjson("/events/stream", { onEvent: () => {} })).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshTokenOnce).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the mint itself fails — there is no new Bearer to try", async () => {
    refreshTokenOnce.mockResolvedValue(null);
    fetchMock.mockResolvedValue(unauthorized());
    await expect(streamNdjson("/events/stream", { onEvent: () => {} })).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the healthy path alone — no re-mint when the first attempt succeeds", async () => {
    fetchMock.mockResolvedValueOnce(ndjson(['{"type":"hello"}', '{"type":"repos"}']));
    const seen: unknown[] = [];
    await streamNdjson("/events/stream", { onEvent: (e) => seen.push(e) });
    expect(refreshTokenOnce).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
  });

  it("does not re-mint on a non-401 failure — that is not an auth problem", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 502 }));
    await expect(streamNdjson("/events/stream", { onEvent: () => {} })).rejects.toThrow(/HTTP 502/);
    expect(refreshTokenOnce).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
