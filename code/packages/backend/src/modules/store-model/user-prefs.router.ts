// REST for the per-user prefs (compression_visibility.mdx §1.1): GET returns the signed-in user's
// `features` block (defaults when they have no file), PATCH merges a patch onto it. Unlike table views this
// is a SETTING the user deliberately changed, so a failed write is a real error the Settings page reports.
import { Router } from "express";
import { z } from "zod";
import { UserFeaturesSchema, UserPrefsSchema } from "@lfb/shared";
import { loadUserPrefs, saveUserPrefs } from "./user-prefs.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { log } from "../../shared/logging.js";

export const userPrefsRouter = Router();
userPrefsRouter.use(requireAllowListed);

// GET /api/user-prefs — a user with no email (should not happen behind the allow-list) or an unreadable
// file reads back the defaults: compression hidden, which is exactly the safe default.
userPrefsRouter.get("/", (req, res) => {
  const email = currentUser(req).email;
  const defaults = UserPrefsSchema.parse({});
  if (!email) return res.json({ ok: true, data: defaults });
  try {
    res.json({ ok: true, data: loadUserPrefs(email) });
  } catch (e) {
    log.warn("user-prefs", `load failed for ${email}: ${(e as Error).message}`);
    res.json({ ok: true, data: defaults });
  }
});

// PATCH /api/user-prefs — body { features?: { compression?: boolean } }. Only the keys sent change.
const patchBody = z.object({ features: UserFeaturesSchema.partial().optional() });
userPrefsRouter.patch("/", async (req, res) => {
  const email = currentUser(req).email;
  if (!email) return res.status(401).json({ ok: false, error: "not signed in" });
  const body = patchBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "invalid prefs" });
  try {
    res.json({ ok: true, data: await saveUserPrefs(email, body.data) });
  } catch (e) {
    log.error("user-prefs", `save failed for ${email}: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: "could not save your settings" });
  }
});
