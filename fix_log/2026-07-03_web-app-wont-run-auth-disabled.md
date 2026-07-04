# FIXED — web app wouldn't run (Google OAuth silently disabled)

## Bug report

The web app did not run. `error.err` (at the state root `~/T/_large_files_bridge/error.err`,
resolved by `config/state-dir.ts` → `resolveLogDir()`) was flooding with the same WARN over and
over, right up to the latest boot:

```
[WARN] [auth] Failed to read/parse Google creds at /Users/bryanstarbuck/.credentials/large_files_bridge.json:
              Expected property name or '}' in JSON at position 2 (line 2 column 1)
```

followed each boot by:

```
[INFO] [auth] Google OAuth credentials not configured (sign-in disabled).
[INFO] [auth] No Google creds — auth Frontend API not mounted (dev/offline mode).
```

Because LFB has **no anonymous / no-login path** (charter: every session belongs to an
allow-listed authenticated user), disabling Google OAuth makes the app effectively unusable —
"the web app does not run."

## Where the log lives

`error.err` and `log.log` are written by `code/packages/backend/src/shared/logging.ts` into the
directory returned by `resolveLogDir()` — `LFB_LOG_DIR`, else the state root, which defaults to
`~/T/_large_files_bridge/` (`config/state-dir.ts`). `error.err` gets every WARN/ERROR/FATAL.

## Root cause

`~/.credentials/large_files_bridge.json` was indented with **non-breaking spaces (U+00A0)** instead
of ASCII spaces. Hex of line 2 began `c2 a0 c2 a0` (two U+00A0) rather than `20 20`. U+00A0 is not
valid JSON whitespace, so `JSON.parse` in `loadGoogleCreds()` (`config/credentials-file.ts`) threw
at "line 2 column 1", the whole creds object was discarded, and OAuth was reported as
unconfigured — even though the client id/secret were present and correct. This is exactly the kind
of corruption a hand-edited or copy-pasted secrets file picks up (rich-text paste, some editors).

Two other WARN families in `error.err` were investigated and found to be **already fixed** in the
current code (stale entries, last seen 07-03, not reoccurring):
- `[auth] Token verification failed: verifyToken: issuer must be an absolute URL` — handled by
  `identify.ts` now forcing the embedded HS256 path (`verifyToken(..., { embedded: true })`).
- `[ipfs] Could not enforce compliance: ... "Reprovider not found"` — handled by
  `enforceCompliance()` treating a Kubo `not found` on `Reprovider.Strategy` as a benign
  capability gap (`ipfs.service.ts`).

## Fix summary

1. **Resilient parse (code).** `config/credentials-file.ts` now parses via `parseCredsJson()`,
   which first tries `JSON.parse` as-is (well-formed files untouched) and, only on failure,
   normalizes the invisible-whitespace characters that look identical to an ASCII space —
   BOM, NBSP (U+00A0), the U+2000–U+200A space family, U+202F/U+205F, ideographic space
   (U+3000), and zero-width chars — then retries. On a successful repair it logs a WARN telling
   the user to re-save the file with plain ASCII. A single stray non-breaking space can no longer
   silently disable all sign-in.

2. **Repaired the data file.** Rewrote `~/.credentials/large_files_bridge.json` with clean ASCII
   spaces (2-space indent). Line 2 now begins `20 20`; the file parses as-is (no repair path hit).

## Files changed

- `code/packages/backend/src/config/credentials-file.ts` — added `NBSP_LIKE` / `ZERO_WIDTH`
  regexes (written as `\uXXXX` escapes) and the exported `parseCredsJson()` helper; `loadGoogleCreds()`
  now calls it and warns when a repair was needed.
- `~/.credentials/large_files_bridge.json` (out-of-repo user data) — non-breaking spaces replaced
  with ASCII spaces.

## Verification

- `pnpm typecheck` (backend) — passes.
- Node harness: the real creds file fails `JSON.parse` as-is, parses after normalization, and
  yields the correct `clientId` — confirmed before repairing the file.
- `just run`: web app `:2222` → HTTP 200, backend `:8787/api/health` → HTTP 200.
- `log.log` after the file settled: `OpenAuthFederated Frontend API mounted at /api/v1`
  (auth **enabled** — previously "not mounted"), and **zero** creds-parse WARNs on subsequent boots.
