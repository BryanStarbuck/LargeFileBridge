// A TOKEN THAT EXPIRED IN OUR QUEUE IS NOT AN ATTACK (error catalog #8).
//
// The browser never attaches a token with under 10 s of life, yet 16 `"exp" claim timestamp check failed`
// WARNs landed in one burst after a restart: the tokens lapsed while their requests sat behind a stalled
// loop or a sleeping laptop. Verification now allows a small, standard clock tolerance, and an expired token
// (which the client re-mints and replays on the 401) is logged at INFO — while a bad signature stays WARN.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";

// A plain stub, not a vi.fn: under this vitest, a rejection returned by a vi.fn was reported as a test
// failure even though identify() catches it — and the caught rejection is exactly the path under test.
let verifyImpl: (token: string, opts: unknown) => Promise<unknown> = async () => ({});
const verifyCalls: unknown[][] = [];
vi.mock("@auth/backend", () => ({
  verifyToken: (...a: unknown[]) => {
    verifyCalls.push(a);
    return verifyImpl(a[0] as string, a[1]);
  },
}));
vi.mock("./auth-frontend.js", () => ({ AUTH_ISSUER: "large-file-bridge" }));
vi.mock("../store-model/config.service.js", () => ({
  getAppConfig: () => ({ server: { mode: "local" }, access: { allowed_emails: ["a@example.com"] } }),
}));
vi.mock("../../config/credentials-file.js", () => ({ hasGoogleCreds: () => true, loadApiSecret: () => null }));
vi.mock("../security/security.service.js", () => ({ allowListed: () => true, securityConfigured: () => true }));

const { identify, isExpiredTokenError, TOKEN_CLOCK_TOLERANCE_MS } = await import("./identify.js");
const { log } = await import("../../shared/logging.js");

function reqWithBearer(): Request {
  return {
    method: "POST",
    path: "/client-log",
    header: (h: string) => (h.toLowerCase() === "authorization" ? "Bearer t.o.k" : undefined),
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as Request;
}

beforeEach(() => {
  verifyCalls.length = 0;
  verifyImpl = async () => ({});
});
afterEach(() => vi.restoreAllMocks());

describe("identify — clock tolerance", () => {
  it("verifies with a SMALL clock tolerance (≤ 60 s) so a token that lapsed in our own queue still passes", async () => {
    verifyImpl = async () => ({ email: "a@example.com", sid: "s" });
    const req = reqWithBearer();
    await identify(req, {} as Response, () => {});
    const opts = verifyCalls[0]![1] as { clockSkewInMs?: number; issuer?: string; embedded?: boolean };
    expect(opts.clockSkewInMs).toBe(TOKEN_CLOCK_TOLERANCE_MS);
    expect(TOKEN_CLOCK_TOLERANCE_MS).toBeGreaterThan(0);
    expect(TOKEN_CLOCK_TOLERANCE_MS).toBeLessThanOrEqual(60_000);
    // The security-bearing checks are untouched.
    expect(opts.issuer).toBe("large-file-bridge");
    expect(opts.embedded).toBe(true);
  });
});

describe("identify — an expired token is routine; a forged one is not", () => {
  it("an expired token logs INFO (the client re-mints and retries), and the caller is anonymous", async () => {
    verifyImpl = async () => {
      throw Object.assign(new Error('"exp" claim timestamp check failed'), { code: "ERR_JWT_EXPIRED" });
    };
    const warn = vi.spyOn(log, "warn");
    const info = vi.spyOn(log, "info");
    const req = reqWithBearer();
    await identify(req, {} as Response, () => {});
    expect(warn).not.toHaveBeenCalled();
    expect(info.mock.calls.some(([ctx, m]) => ctx === "auth" && /"exp" claim/.test(m))).toBe(true);
    expect((req as Request & { user?: { allowListed: boolean } }).user?.allowListed).toBe(false);
  });

  it("a bad signature stays a WARN", async () => {
    verifyImpl = async () => {
      throw Object.assign(new Error("signature verification failed"), { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" });
    };
    const warn = vi.spyOn(log, "warn");
    await identify(reqWithBearer(), {} as Response, () => {});
    expect(warn.mock.calls.some(([ctx, m]) => ctx === "auth" && /signature/.test(m))).toBe(true);
  });

  it("isExpiredTokenError recognises jose's code and message, and nothing else", () => {
    expect(isExpiredTokenError({ code: "ERR_JWT_EXPIRED" })).toBe(true);
    expect(isExpiredTokenError(new Error('"exp" claim timestamp check failed'))).toBe(true);
    expect(isExpiredTokenError(new Error('unexpected "iss" claim value'))).toBe(false);
    expect(isExpiredTokenError(null)).toBe(false);
  });
});
