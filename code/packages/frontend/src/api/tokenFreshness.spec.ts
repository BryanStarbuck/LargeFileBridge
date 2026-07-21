// THE REGRESSION GUARD for expired Bearers reaching the API (authentication.mdx §4).
//
// The bug this locks closed: ordinary page loads showed up in error.err as
//   [WARN] [auth] Token verification failed (GET /todo/batches): "exp" claim timestamp check failed
// The browser attached a 15-minute access token that had ALREADY lapsed, so the user silently got a
// failed fetch mid-session. Two directions matter and both are asserted here:
//   • a token close to `exp` must be renewed BEFORE it is attached (never discover expiry via a 401);
//   • a token that is merely "not expired yet" must NOT be attached after a failed re-mint — it would
//     lapse in flight and reproduce the exact warning above.
import { describe, expect, test } from "vitest";
import {
  TOKEN_HARD_FLOOR_S,
  TOKEN_MIN_TTL_S,
  WATCHDOG_MIN_TTL_S,
  needsProactiveRenewal,
  needsRefreshBeforeUse,
  safeToAttachStaleToken,
  secondsRemaining,
} from "./tokenFreshness.js";

const NOW = 1_800_000_000; // arbitrary fixed epoch second
const expIn = (seconds: number): number => NOW + seconds;

describe("attach-time refresh guard", () => {
  test("a healthy token (most of a 15-minute life left) is attached as-is", () => {
    expect(needsRefreshBeforeUse(expIn(14 * 60), NOW)).toBe(false);
  });

  test("a token inside the attach window is re-minted first", () => {
    expect(needsRefreshBeforeUse(expIn(TOKEN_MIN_TTL_S - 1), NOW)).toBe(true);
  });

  test("an ALREADY-expired token is always refreshed (the reported failure)", () => {
    expect(needsRefreshBeforeUse(expIn(-1), NOW)).toBe(true);
    expect(needsRefreshBeforeUse(expIn(-3600), NOW)).toBe(true);
  });
});

describe("stale-token fallback after a failed re-mint", () => {
  test("an expired token is NEVER attached", () => {
    expect(safeToAttachStaleToken(expIn(0), NOW)).toBe(false);
    expect(safeToAttachStaleToken(expIn(-1), NOW)).toBe(false);
  });

  test("'not expired yet' is not enough — the hard floor must be cleared", () => {
    expect(safeToAttachStaleToken(expIn(TOKEN_HARD_FLOOR_S), NOW)).toBe(false);
    expect(safeToAttachStaleToken(expIn(TOKEN_HARD_FLOOR_S + 1), NOW)).toBe(true);
  });
});

describe("proactive keep-alive", () => {
  test("renews EARLIER than the attach guard, so the attach guard rarely bites", () => {
    expect(WATCHDOG_MIN_TTL_S).toBeGreaterThan(TOKEN_MIN_TTL_S);
    const exp = expIn(WATCHDOG_MIN_TTL_S - 1);
    expect(needsProactiveRenewal(exp, NOW)).toBe(true);
    expect(needsRefreshBeforeUse(exp, NOW)).toBe(false);
  });

  test("leaves a freshly minted token alone", () => {
    expect(needsProactiveRenewal(expIn(15 * 60), NOW)).toBe(false);
  });
});

test("secondsRemaining is signed — a lapsed token reads negative", () => {
  expect(secondsRemaining(expIn(30), NOW)).toBe(30);
  expect(secondsRemaining(expIn(-30), NOW)).toBe(-30);
});
