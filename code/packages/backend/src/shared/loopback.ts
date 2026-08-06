// One source of truth for "is this request from the local machine (loopback)?" (security audit
// findings 1 & 9).
//
// THE PEER SOCKET, NEVER `req.ip`. With `app.set("trust proxy", "loopback")` (main.ts) Express derives
// `req.ip` from X-Forwarded-For as soon as the connecting socket is itself loopback — which is exactly the
// situation a same-host reverse proxy creates. A bare `proxy_pass` sends no X-Forwarded-For at all, so
// `req.ip` becomes 127.0.0.1 for EVERY remote visitor, and a caller who does send one only has to write
// `X-Forwarded-For: 127.0.0.1` to be believed. That turns the first-run Security Setup write
// (security.router.ts — unauthenticated by design, since there is no user yet) and the loopback-only
// shutdown/worker triggers (internal.router.ts) into internet-reachable endpoints on a `server`-mode
// deployment, which binds 0.0.0.0. The TCP peer address cannot be forged by a header, so it is what these
// guards ask.
//
// Residual, and deliberately so: a reverse proxy on this same machine IS a loopback peer, so a hosted
// instance fronted by one still needs its own edge rule for /api/internal and /api/security. What is fixed
// here is the part the app controls — no request can TALK its way into being local.
import type { Request } from "express";

export function isLoopback(req: Request): boolean {
  const raw = req.socket?.remoteAddress ?? "";
  const ip = raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127."); // the whole 127.0.0.0/8 loopback range
}
