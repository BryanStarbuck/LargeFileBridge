# FIXED — authentication timed out / required re-login after a server restart

## Bug report

"This authentication should not time out. It should last 10 months. I just restarted the server,
rebuilt it, and restarted it, and it required me to log in."

## Root cause

`auth-frontend.ts → constructAuthFrontend()` called `createFederatedFrontend(...)` **without**
passing any session-lifetime options, so it inherited the OpenAuthFederated library defaults
(`frontend.ts → normalizeConfig`):

* `sessionTtlSeconds` default = **7 days** (absolute maximum lifetime)
* `inactivityTimeoutSeconds` default = **12 hours** (idle timeout)
* `accessTokenTtlSeconds` default = 60 s

The 12-hour idle timeout is what bit on restart. Proof from the durable session records under
`~/T/_large_files_bridge/users/bryan@act3ai.com/sessions/`:

* An older session was `createdAt 2026-07-02T17:12Z`, `lastActiveAt 2026-07-03T23:09Z` — a ~30-hour
  activity gap, **well past 12h**, so `readSession()` aged it out (returned null) and forced a new
  sign-in.
* Every record's `expireAt` was exactly `createdAt + 7 days`, confirming the 7-day default ceiling.

It was **not** a persistence problem: the signing secret (`.auth_session_secret`) and the
`FileSessionStore` records both persist to the state root and survive restarts. The only thing
aging sessions out was the short default TTLs.

## Fix

1. **Code** — `code/packages/backend/src/modules/auth/auth-frontend.ts`: pass the three
   session-lifetime options to `createFederatedFrontend`, matching the sister apps
   (EmailDeliveryHero, the_starbucks, all/app) exactly:

   ```ts
   const TEN_MONTHS_SECONDS = 10 * 30 * 24 * 60 * 60; // 300 days = 25,920,000s
   sessionTtlSeconds: TEN_MONTHS_SECONDS,
   accessTokenTtlSeconds: 15 * 60,
   inactivityTimeoutSeconds: TEN_MONTHS_SECONDS,
   ```

   `inactivityTimeoutSeconds == sessionTtlSeconds` so an idle session is bounded only by the
   10-month absolute lifetime, never aged out by inactivity.

2. **Existing sessions** — the durable record's `expireAt` ceiling is fixed at **session creation**
   and is never re-extended on token mint (`handleMintToken` only touches `lastActiveAt`). So the
   two live session records still carried the old 7-day ceiling. Bumped their `expireAt` on disk to
   `createdAt + 10 months` (→ April 2027) so the current login survives with no re-auth. New logins
   get 10 months automatically.

## Why no re-login is needed now

On restart the browser presents its still-valid session cookie; `readSession()` finds the durable
record (now `expireAt` in 2027, inactivity ceiling now 10 months) and the first token mint re-signs
the cookie + Max-Age to the full 10 months. The frontend re-hydrates from the cookie
(`GET /api/v1/client`) and mints a fresh Bearer — it never depends on a stored access token.

## Verification

* `npx tsc -p tsconfig.json --noEmit` → exit 0.
* `GET /api/health/auth-config` on the running server → `oauthConfigured: true`, confirming the
  server runs the real-OAuth branch (`constructAuthFrontend` with Google creds) that was edited.
* The app runs via `tsx src/main.ts` (no build artifact), so the source edit is live on the next
  restart — a restart is all that's needed to pick up the new TTLs.

## Spec updated

`pm/storage.mdx` §10 — added a "Session lifetime" subsection documenting the 10-month policy, the
three required options, why the library defaults are too short, and that the `expireAt` ceiling is
set at session creation (policy changes take effect on next sign-in).
