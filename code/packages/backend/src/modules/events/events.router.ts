// The live STATE-EVENT STREAM (storage_company.mdx §8.9, one_repo.mdx §4.11, performance.mdx).
//
// WHY NDJSON AND NOT SSE. Every `/api` call must carry the OpenAuth federated Bearer token, and
// `EventSource` cannot set an Authorization header — an SSE endpoint would either bypass the allow-list
// gate or need a second, weaker auth path. Neither is acceptable (CLAUDE.md: only allow-listed users, no
// anonymous access path). So this reuses the EXACT transport the Full Paths table already streams over:
// `fetch` + `ReadableStream` reading newline-delimited JSON, with the normal Bearer token attached
// (`streamNdjson.ts`). One transport, one auth path, no new surface.
//
// WHY THIS IS NOT POLLING. performance.mdx LOCKS "no background polling". A stream is the mechanism that
// lets that rule hold: the client makes ONE request and then sits idle until the server has something to
// say, instead of asking every N seconds forever. Pages stay fresh AND the machine stays quiet.
//
// The stream carries no page data — only `{topic, revision}`. The client re-asks through its normal
// authenticated route, so authorization is enforced in exactly one place and a missed bump self-heals.
import { Router } from "express";
import { requireAllowListed } from "../auth/identify.js";
import { subscribe, currentRevisions, subscriberCount } from "./state-events.service.js";
import { log } from "../../shared/logging.js";

export const eventsRouter = Router();
eventsRouter.use(requireAllowListed);

// A line every 25s when nothing is happening. Two jobs: it keeps intermediaries from reaping an idle
// connection, and it gives the CLIENT a liveness signal — a stream that has gone quiet because it died is
// otherwise indistinguishable from one that is quiet because nothing changed, which is precisely the
// "silently stale page" failure this module exists to prevent.
const HEARTBEAT_MS = 25_000;

export type StateStreamEvent =
  | { type: "hello"; revisions: Record<string, number> }
  | { type: "bump"; topic: string; revision: number }
  | { type: "heartbeat" };

// GET /api/events/stream — an open NDJSON stream of state bumps. One JSON object per line:
//   {"type":"hello","revisions":{...}}          once, on connect
//   {"type":"bump","topic":"repo:charlie-kirk","revision":7}
//   {"type":"heartbeat"}                        every 25s of quiet
eventsRouter.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // never let a reverse proxy buffer a live stream

  const write = (ev: StateStreamEvent): void => {
    // A socket the client already closed is NOT a broken subscriber — it is a client that is about to
    // reconnect. Check every "this is gone" signal Node gives us (not just `writableEnded`, which stays
    // false when the peer vanished without us calling end()) so we tear down quietly instead of throwing
    // out into the bus and being dropped as if we had misbehaved.
    if (closed || res.writableEnded || res.destroyed || res.socket?.destroyed) {
      cleanup();
      return;
    }
    try {
      res.write(JSON.stringify(ev) + "\n");
      (res as unknown as { flush?: () => void }).flush?.();
    } catch (e) {
      // A write to a half-closed socket must not throw out of the bus (state-events drops throwing
      // subscribers, but this path also runs from the heartbeat timer). Tear down cleanly instead.
      log.debug("events", `stream write failed, closing: ${(e as Error).message}`);
      cleanup();
    }
  };

  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let closed = false;

  function cleanup(): void {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    // Ending a response whose socket is already gone can itself throw (ERR_STREAM_DESTROYED / EPIPE).
    // Cleanup runs from inside the bus's fan-out, so a throw here is exactly what got a healthy
    // subscriber logged as "threw and was dropped". Nothing about teardown is worth propagating.
    try {
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch {
      /* socket already gone — nothing to close */
    }
    log.debug("events", `state stream closed (${subscriberCount()} remaining)`);
  }

  // The client going away is the ONLY normal end of this stream — always unsubscribe, or the subscriber
  // set grows without bound for the life of the process. Listen on BOTH req and res: `req.close` covers
  // the request stream ending, while `res.close`/`res.error` are what actually fire when the peer resets
  // a long-lived response (the SSE/NDJSON case). Unregistering here means the subscriber is gone BEFORE
  // any write can fail, instead of being discovered by a throwing write mid-broadcast.
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
  // An 'error' on the response with no listener is an unhandled 'error' event — it would take the whole
  // backend down when a browser tab dies at the wrong moment.
  res.on("error", (e) => {
    log.debug("events", `state stream socket error, closing: ${(e as Error).message}`);
    cleanup();
  });

  // `hello` first, so a reconnecting client can compare revisions and tell "nothing moved while I was
  // gone" from "I missed something" without a special-case protocol.
  write({ type: "hello", revisions: currentRevisions() });

  // Belt and braces: the bus DROPS a subscriber that throws (it has to — a notification must never fail
  // the write that persisted data). This stream must therefore never let anything escape, or a live client
  // silently stops receiving bumps while its socket is still perfectly open.
  unsubscribe = subscribe((bump) => {
    try {
      write({ type: "bump", topic: bump.topic, revision: bump.revision });
    } catch (e) {
      log.debug("events", `stream delivery failed, closing: ${(e as Error).message}`);
      cleanup();
    }
  });
  heartbeat = setInterval(() => write({ type: "heartbeat" }), HEARTBEAT_MS);
  // Never let the heartbeat timer hold the process open at shutdown.
  heartbeat.unref?.();

  log.debug("events", `state stream opened (${subscriberCount()} attached)`);
});
