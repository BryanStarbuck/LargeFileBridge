# FIXED — bug found and fixed

Run: 2026-08-19

## Bug report

> find bug. Fix bug
>
> (Contents of `~/.credentials/large_files_bridge.json` — a valid `large_files_bridge.google`
> block with clientId/clientSecret, plus the `api` block.)
>
> `http://localhost:2222/api/v1/sign_in/sso?strategy=oauth_google_workspace&connection=conn_act3ai_com&redirect_url=…`
>
> `Cannot GET /api/v1/sign_in/sso`

## Findings

`Cannot GET …` is Express's default 404 — it means **no route matched**, i.e. the OpenAuthFederated
Frontend API was never mounted. It was not a routing, proxy, `strategy=` or `connection=` problem: the
Vite proxy forwarded correctly and the backend answered directly with the same 404 on `:8787`.

The log said what happened, 2 minutes before the sign-in attempt:

```
12:17:23.589 [INFO] [auth] Created shared API secret for the Large File Bridge CLI at /Users/bryan/.credentials/large_files_bridge.json.
12:17:23.679 [INFO] [auth] Google OAuth credentials not configured (sign-in disabled).
12:17:23.679 [INFO] [auth] No Google creds — auth Frontend API not mounted (dev/offline mode).
```

1. **The mount decision was made once, at boot, and was permanent.** `constructAuthFrontend()`
   (`auth-frontend.ts`) returns a **passthrough** `(req,res,next) => next()` when `hasGoogleCreds()` is
   false. `buildAuthFrontend()` built that once and the delegating handler forwarded to it forever.
   `rebuildAuthFrontend()` existed, but only the **allow-list** writers called it (settings/security
   routers) — nothing watched the credentials.

2. **The credentials legitimately arrive AFTER boot.** That is the documented setup flow — the sign-in
   screen's setup card tells the user which file to create (`credentialsFileInfo()`), and
   `ensureApiSecret()` *creates that very file during boot* with only the `api` block. Here the file was
   born at 12:17:23 with no `google` block and the user pasted one in at 12:19. Boot had already
   committed to the passthrough.

3. **So the product contradicted itself.** `GET /api/health/auth-config` re-reads the file on every call
   and reported `oauthConfigured: true`, `allowedDomains: ["act3ai.com"]` — while the router 404'd. The
   setup card said "configured", the sign-in button said `Cannot GET`. Only a manual restart reconciled
   them, and nothing anywhere said so.

Two smaller things fell out of the same seam:

4. **`hasGoogleCreds()` logged unconditionally on every false.** `identify.ts` calls it on (near) every
   request, so "not configured" was written to `log.log` per-request while the one line that matters —
   the **transition** — was never distinguishable.

## The fix

* **`credentials-file.ts`** — new `googleCredsFingerprint()`: a sha256 of the id/secret pair (never the
  values, so nothing holds a second plaintext copy) over the existing mtime/size-cached read.
  `hasGoogleCreds()` now logs on **state change only**, both directions.
* **`auth-frontend.ts`** — new `ensureFreshAuthFrontend()`, called from the handler `buildAuthFrontend()`
  returns. It compares the current fingerprint against the one the live middleware was **built** with and
  rebuilds on a real change: credentials appearing (mount the real router), changing (a corrected client
  id), or being removed (back to passthrough). Steady-state cost is one `statSync` — the same read
  `identify.ts` already performs.
* **Degrade, don't 500.** The fingerprint is recorded *before* the build, so a failing build is attempted
  once per distinct credentials value rather than once per request, and the previously-built middleware
  keeps serving. Unparsable JSON already reads as "no credentials".

## Verification

* `auth-frontend.spec.ts` drives the real middleware over a real socket, mutating the credentials file
  under a running server. **4 of its 5 tests fail on the unfixed tree** (the passing one is the genuine
  no-credentials 404).
* Live, on the reported URL — was `404 Cannot GET`, now:
  `302 → https://accounts.google.com/o/oauth2/v2/auth?client_id=…&hd=act3ai.com&code_challenge=…`
* Full backend suite: 893 passed. The single failure (`repos-stream.spec.ts`) is **pre-existing** —
  reproduced on a clean tree with both changed files stashed.

## Spec

`pm/authentication.mdx` §3.1 "The mount follows the credentials file, live (LOCKED)", compliance-map row,
and invariant 5: *what the app reports about credentials and what it serves with them are the same read.*
