// One source of truth for "is this request from the local machine (loopback)?" (security audit
// findings 1 & 9). `app.set("trust proxy", "loopback")` in main.ts keeps a spoofed X-Forwarded-For
// from faking loopback, so req.ip is trustworthy here.
import type { Request } from "express";

export function isLoopback(req: Request): boolean {
  const ip = req.ip || req.socket?.remoteAddress || "";
  return ip.includes("127.0.0.1") || ip === "::1" || ip.includes("::ffff:127.0.0.1");
}
