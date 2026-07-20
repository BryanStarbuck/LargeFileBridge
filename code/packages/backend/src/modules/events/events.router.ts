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
    if (res.writableEnded) return;
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
    if (!res.writableEnded) res.end();
    log.debug("events", `state stream closed (${subscriberCount()} remaining)`);
  }

  // The client going away is the ONLY normal end of this stream — always unsubscribe, or the subscriber
  // set grows without bound for the life of the process.
  req.on("close", cleanup);
  req.on("error", cleanup);

  // `hello` first, so a reconnecting client can compare revisions and tell "nothing moved while I was
  // gone" from "I missed something" without a special-case protocol.
  write({ type: "hello", revisions: currentRevisions() });

  unsubscribe = subscribe((bump) => write({ type: "bump", topic: bump.topic, revision: bump.revision }));
  heartbeat = setInterval(() => write({ type: "heartbeat" }), HEARTBEAT_MS);
  // Never let the heartbeat timer hold the process open at shutdown.
  heartbeat.unref?.();

  log.debug("events", `state stream opened (${subscriberCount()} attached)`);
});
