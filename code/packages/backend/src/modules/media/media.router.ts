// REST for the media viewer (media_viewer.mdx §2). grant + probe are allow-list-gated like every data
// route; raw is gated by the signed token instead (a plain <img>/<video> can't send a Bearer header).
// raw serves the user's OWN local file to their OWN browser over HTTP Range — NOT an IPFS gateway/relay.
import fs from "node:fs";
import { Router } from "express";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { log } from "../../shared/logging.js";
import { mintGrant, probeMedia, verifyGrant, mimeFor, parseRange } from "./media.service.js";
import { streamPlayable } from "./transcode.service.js";

export const mediaRouter = Router();

// GET /api/media/grant?path=<abs> — mint a short-lived signed URL (allow-listed), bound to the
// caller's session id (security audit finding 10).
mediaRouter.get("/grant", requireAllowListed, (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  try {
    res.json({ ok: true, data: mintGrant(p, currentUser(req).sessionId) });
  } catch (e) {
    log.warn("media", `grant failed for ${p ?? "<none>"}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/media/probe?path=<abs> — best-effort container/codec/dimensions (allow-listed).
mediaRouter.get("/probe", requireAllowListed, (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  try {
    res.json({ ok: true, data: probeMedia(p) });
  } catch (e) {
    log.warn("media", `probe failed for ${p ?? "<none>"}: ${(e as Error).message}`);
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/media/stream?path=&e=&s=&t= — a live, browser-SAFE fragmented MP4 (H.264 yuv420p + AAC)
// for a video whose real codec the browser can't decode (codecs.mdx §6). Same signed-token gate as
// /raw (a plain <video> can't send a Bearer header). No Range: this is a forward-only transcode pipe.
mediaRouter.get("/stream", async (req, res) => {
  const p = typeof req.query.path === "string" ? req.query.path : undefined;
  const e = typeof req.query.e === "string" ? req.query.e : undefined;
  const s = typeof req.query.s === "string" ? req.query.s : undefined;
  const t = typeof req.query.t === "string" ? req.query.t : undefined;

  let file: { abs: string; size: number };
  try {
    file = verifyGrant(p, e, s, t);
  } catch (err) {
    const msg = (err as Error).message;
    const code = msg === "grant expired" || msg === "bad grant" ? 403 : /ENOENT|not a file/.test(msg) ? 404 : 400;
    log.warn("media", `stream grant rejected (${code}) for ${p ?? "<none>"}: ${msg}`);
    return res.status(code).json({ ok: false, error: msg });
  }

  // streamPlayable is async now (its ffprobe plan step must not block the event loop — to_fix.mdx §3.3.4).
  // It resolves once ffmpeg is piping, not when the stream ends, and reports its own faults onto `res`.
  await streamPlayable(file.abs, res, (cb) => req.on("close", cb));
});

// GET /api/media/raw?path=&e=&t= — stream the bytes with Range (token-gated, NOT allow-list-gated).
mediaRouter.get("/raw", (req, res) => {
  const path = typeof req.query.path === "string" ? req.query.path : undefined;
  const e = typeof req.query.e === "string" ? req.query.e : undefined;
  const s = typeof req.query.s === "string" ? req.query.s : undefined;
  const t = typeof req.query.t === "string" ? req.query.t : undefined;

  let file: { abs: string; size: number };
  try {
    file = verifyGrant(path, e, s, t);
  } catch (err) {
    const msg = (err as Error).message;
    // A missing file is a 404; a bad/expired token is a 403; anything else a 400.
    const code = msg === "grant expired" || msg === "bad grant" ? 403 : /ENOENT|not a file/.test(msg) ? 404 : 400;
    log.warn("media", `raw grant rejected (${code}) for ${path ?? "<none>"}: ${msg}`);
    return res.status(code).json({ ok: false, error: msg });
  }

  const type = mimeFor(file.abs);
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

  const range = parseRange(req.headers.range, file.size);
  if (range === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${file.size}`);
    return res.status(416).end();
  }

  const { start, end } = range ?? { start: 0, end: file.size - 1 };
  const status = range ? 206 : 200;
  if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${file.size}`);
  res.setHeader("Content-Length", String(end - start + 1));
  res.status(status);

  if (req.method === "HEAD") return res.end();

  const stream = fs.createReadStream(file.abs, { start, end });
  stream.on("error", (err) => {
    log.warn("media", `stream error ${file.abs}: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "stream error" });
    else res.destroy();
  });
  // Abort the disk read if the client (a seeking <video>) drops the connection.
  req.on("close", () => stream.destroy());
  stream.pipe(res);
});
