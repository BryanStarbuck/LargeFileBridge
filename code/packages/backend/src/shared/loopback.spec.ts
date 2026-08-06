// A HEADER MUST NOT BE ABLE TO CLAIM TO BE THIS COMPUTER (security.mdx §8.4).
//
// `isLoopback` is the whole gate on the first-run Security Setup write (unauthenticated by design — there
// is no user yet), on the shutdown/worker triggers, on the OS-open hand-off, and on the CLI api-key and
// dev-auth principals. It used to read `req.ip`, which Express derives from X-Forwarded-For whenever the
// connecting socket is loopback — precisely what a same-host reverse proxy makes true of every remote
// visitor. `X-Forwarded-For: 127.0.0.1` was therefore a valid way to say "I am this computer".
//
// So the question it asks is the TCP peer, which no header can rewrite.
import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { isLoopback } from "./loopback.js";

const req = (remoteAddress: string | undefined, ip?: string): Request =>
  ({ ip, socket: { remoteAddress } }) as unknown as Request;

describe("isLoopback", () => {
  it("accepts the real local peers", () => {
    expect(isLoopback(req("127.0.0.1"))).toBe(true);
    expect(isLoopback(req("::1"))).toBe(true);
    expect(isLoopback(req("::ffff:127.0.0.1"))).toBe(true);
    expect(isLoopback(req("127.0.1.1"))).toBe(true); // the whole 127.0.0.0/8 range is loopback
  });

  it("rejects a remote peer no matter what req.ip was resolved to", () => {
    // The X-Forwarded-For bypass: Express hands back a spoofed `req.ip`, the socket does not lie.
    expect(isLoopback(req("203.0.113.7", "127.0.0.1"))).toBe(false);
    expect(isLoopback(req("::ffff:203.0.113.7", "::1"))).toBe(false);
  });

  it("rejects an address that merely CONTAINS a loopback address", () => {
    // The old substring test said yes to both of these.
    expect(isLoopback(req("10.127.0.0.1"))).toBe(false);
    expect(isLoopback(req("2001:db8::ffff:127.0.0.1"))).toBe(false);
  });

  it("rejects a request with no peer address rather than defaulting to trusted", () => {
    expect(isLoopback(req(undefined))).toBe(false);
    expect(isLoopback({} as unknown as Request)).toBe(false);
  });
});
