// Web-session activity endpoint (sessions.mdx §5). The frontend pings here on every page render; we
// roll pings into the user's open session and, on a new session that lands on a >48h-stale machine,
// fire a non-blocking pin pass. Best-effort: a tracking hiccup must never break the page, so failures
// return an inert result rather than a 500.
import { Router } from "express";
import type { SessionActivityResult } from "@lfb/shared";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { recordActivity, getSessions } from "./sessions.service.js";
import { log } from "../../shared/logging.js";

export const sessionsRouter = Router();
sessionsRouter.use(requireAllowListed);

sessionsRouter.post("/activity", async (req, res) => {
  const email = currentUser(req).email;
  if (!email) {
    // requireAllowListed guarantees an allow-listed principal; an allow-listed user always has an
    // email, so this is defensive. No email ⇒ nothing to track — ack inertly.
    res.json({ ok: true, data: inert() });
    return;
  }
  try {
    const data = await recordActivity(email);
    res.json({ ok: true, data });
  } catch (e) {
    // Session tracking is a background nicety — never let it surface as an error to the browser.
    log.warn("sessions", `recordActivity failed for ${email}: ${(e as Error).message}`);
    res.json({ ok: true, data: inert() });
  }
});

// The user's last five web sessions (sessions.mdx §4) — for a future diagnostics/settings surface.
sessionsRouter.get("/", (req, res) => {
  const email = currentUser(req).email;
  res.json({ ok: true, data: email ? getSessions(email) : [] });
});

function inert(): SessionActivityResult {
  return { newSession: false, autoPinTriggered: false, lastPinAt: null };
}
