# FIXED — the pages spun forever because no wait on the client had a deadline

Run: 2026-09-09

## Bug report

> debug where this wapp stores error.err
>
> fix all areas in the code that map to errors reported
>
> and
>
> it is hanging.  Debug.

## Where `error.err` lives

`~/T/_large_files_bridge/error.err` — the state root (`LFB_STATE_DIR`, else `~/T/_large_files_bridge/`,
resolved by `resolveStateDir()` / `resolveLogDir()` in
`~/repos/LargeFileBridge/code/packages/backend/src/config/state-dir.ts`). It is the durable fault trail:
WARN/ERROR/FATAL only, written synchronously so it survives a crash, rotating at 5 MiB × 5 generations
(`RollingFileWriter` in `code/packages/backend/src/shared/logging.ts`). Its siblings are `log.log` (the
full log) and `launcher.log` (everything `pnpm dev` prints).

## What the fault trail said — and what its silence said

`debugging.mdx` Node 0, one grep:

```
[client:perf.route] PAGE STILL SPINNING after 80264ms: /repos/dbd9c2c05564a3fc …
[client:perf.route] PAGE STILL SPINNING after 58633ms: … waiting on ["authInit"], ["securityConfig"],
                    ["me"], ["progress"], ["ipfsLiveness"], ["repo","dbd9c2c05564a3fc"]
```

36 of them on 2026-09-09, up to **80 seconds**, naming *every* query at once.

The method says to cross-check those against the backend. **The backend had nothing to say.** Not one
`[request] STILL OPEN`, not one `[request] SLOW` for those moments — the 308 grep hits for `STILL OPEN` are
all the *text of the client's own message*, none a real server line. And no `[client:perf.longtask]`
entries either. Probed cold at the same time, the endpoints the page was waiting on answered instantly:

```
/api/auth/me          code=200 total=0.003s
/api/security/config  code=200 total=0.001s
/api/progress         code=200 total=0.001s
```

So the server was not slow and the tab's main thread was not busy — the two owners Node 0 knew about. The
requests had gone out and simply never come back. **The absence of evidence was the evidence.**

## Findings

### 1. Nothing on the client bounded any wait — the hang

Three unbounded waits, in ascending order of blast radius:

* **`axios.create({ baseURL: "/api", withCredentials: true })`** set no `timeout`, and axios's default is
  `0` — wait forever.
* **`RealAuthCore`'s `fetch(.../client)` and `fetch(.../tokens)`** carry no `AbortSignal` either
  (OpenAuthFederated is a sister library, read-only to us). `load()` *does* retry on a backoff — but only
  when the fetch **rejects**. A socket that is never answered and never reset (laptop woken mid-flight, the
  backend replaced under a kept-alive connection) rejects never, so the backoff never fires and `load()`
  never resolves.
* **`getFreshToken()` is awaited *inside* the axios request interceptor.** So one wedged mint stalls every
  request in the tab **before any of them is sent** — which is exactly why one spinner named `authInit`,
  `me`, `securityConfig`, `progress`, `ipfsLiveness` and `repo` together.

And an unbounded wait **disarms the recovery the app already had**. `main.tsx`'s boot gate rides out an
absent backend by reading `q.isPending && q.failureCount > 0 && isTransientNetworkError(q.failureReason)`.
A request that never *fails* has `failureCount === 0`, so `backendUnreachable` stayed false, "Reconnecting
to Large File Bridge…" never appeared, and the gate fell through to a bare, permanent `Loading…`. The
machinery was correct and simply never armed.

**Fixed** — one module, three call sites:

* `code/packages/frontend/src/lib/deadline.ts` (new) — `withDeadline()`, `withDeadlineOr()`,
  `timeoutError()`. The error is deliberately **axios-shaped** (`isAxiosError`, `code: "ECONNABORTED"`), so
  `lib/transientError.ts` already classifies it as "the backend isn't there" and the existing
  retry/Reconnecting path arms itself with **no second code path**. Rebuilding it as a plain `Error` is the
  trap `api/axios.ts`'s `unwrap` header warns about.
* `code/packages/frontend/src/api/axios.ts` — a request interceptor applies `READ_DEADLINE_MS` (45 s) to
  **GET/HEAD/OPTIONS only**. Commands stay unbounded on purpose: `/ipfs/rescan` walks the whole pinset,
  `/repos/:id/pin` pins a repo, `/ipfs/daemon` starts Kubo, and cutting one off at 45 s would abandon work
  still running server-side. An explicit per-call `timeout` always wins.
* `code/packages/frontend/src/api/authCore.ts` — `AUTH_DEADLINE_MS` (12 s) on `getFreshToken()`,
  `refreshTokenOnce()` and the `reloadSession` bridge. A blown mint resolves `null`, the request goes out
  unauthenticated, the backend answers 401, and the existing single-flight 401 backstop recovers in one
  round trip. Because `refreshTokenOnce()` is single-flight, the deadline also **clears
  `refreshInFlight`** — otherwise every later caller joins the same wedged promise.
* `code/packages/frontend/src/main.tsx` — the `authInit` query deadlines `authCore.load()` and **resolves**
  with the SDK's own non-`"loaded"` state rather than throwing. That is what puts the gate on the
  "Reconnecting…" branch *and* arms its 3 s poll; a throw with `retry: false` would have left `auth.data`
  undefined and landed back on `Loading…`.
* `code/packages/frontend/src/lib/streamNdjson.ts` — `CONNECT_DEADLINE_MS` (20 s) on the **headers phase
  only**. An NDJSON body is long-lived by design (`/events/stream` holds open between heartbeats), so a
  deadline on the read loop would sever every healthy stream on a schedule; the body's guard is
  `liveStream.ts`'s stall watchdog, which already exists. The fetch now runs on our own controller with the
  caller's `signal` **relayed into it and left attached for the life of the response** — detaching it once
  headers arrived would have quietly severed the caller's control over the body, which is the only thing
  that ends a long-lived stream.

### 2. `loop-watch` reported laptop sleep as a 15-minute event-loop stall

The loudest lines in the trail were arithmetically impossible:

```
EVENT LOOP BLOCKED: … stopped for up to 935229.1ms in the last 60s
EVENT LOOP BLOCKED: … stopped for up to 352187.3ms in the last 60s   (BLOCKED BY totalled 23ms)
```

935 seconds of blockage inside a 60-second window. `monitorEventLoopDelay` is a libuv histogram that keeps
accumulating while the **process** is frozen, so a lid-close lands in it as one enormous delay sample; the
histogram cannot tell a stall from a suspension because it cannot see wall time.

This was not merely untidy. `debugging.mdx` Node 0 sends every hang investigation to these lines first, and
a false one names a culprit section that did nothing wrong.

**Fixed** in `code/packages/backend/src/shared/loop-watch.ts`: `closeWindow()` now records how long each
window **actually** lasted, and `suspensionGapMs()` calls an overrun of more than 2× the window a
suspension. Those windows log `PROCESS SUSPENDED for about Ns` at INFO — the honest explanation for the
page that was spinning when the user came back — instead of a stall with a blamed section.

### 3. A dead Postgres was rediscovered 3 seconds at a time, on request paths

```
[db] idle client error (pool stays up): terminating connection due to unexpected postmaster exit
[db] storage.syncFence: timeout exceeded when trying to connect (+16 more suppressed in the last minute)
```

`pg` raises `error` on the pool the instant an idle connection dies — the earliest possible evidence — and
it was only being logged. `db.ts`'s health latch only learned of the failure when a **query** failed, and a
query fails by waiting out `connectionTimeoutMillis` (3 s). So seventeen call sites each blocked a request
path for 3 s to discover a fact the pool already knew.

**Fixed**: `pool.ts` gained `setPoolErrorObserver()` (a callback, because `db.ts` imports `pool.ts` and a
direct call back would be a cycle), and `db.ts` registers `noteDbHealth(false)` on it. `dbEnabled()` answers
false from the moment the postmaster dies, and `HEALTH_RECHECK_MS` later a background probe picks the server
back up when it returns. The YAML fallback itself was already correct and is unchanged.

## Deliberately not changed

* **`storage.reconcile.yielding`** dominates the `BLOCKED BY` ranking (5–17 s per window across 108 repos),
  but every row carries the `(yielded)` suffix: it is real CPU taken in 8 ms slices that handed the loop
  back between them, so it froze nothing. Per Node 0's own rule — rank it, do not chase it. It is a
  standing cost worth attacking on its own terms (the walk covers ~30,000 mirrored files a pass), not part
  of this hang.
* **`[watchdog] 6 other computers are running an older Large File Bridge`** and `[main] the previous session
  ended ABNORMALLY` are both instrumentation working as designed, not faults.

## Verification

* `pnpm -r typecheck` — clean.
* `pnpm -r test` — **1,440 passed** (frontend 176, backend 1,264), 12 skipped, 0 failed.
* New specs: `frontend/src/lib/deadline.spec.ts` (9), `frontend/src/api/readDeadline.spec.ts` (6),
  `backend/src/shared/loop-watch.spec.ts` (6). The load-bearing one asserts that a synthesized timeout is
  classified transient by `isTransientNetworkError()` — if that ever goes false, a deadline stops arming
  "Reconnecting…" and starts showing the error card for a condition the app is meant to ride out.
* `just stop` / `just run`, then the endpoints that had been spinning, over the real HTTP+auth path:
  `/api/auth/me` 1.7 ms, `/api/security/config` 1.1 ms, `/api/progress` 1.3 ms, `/api/repos/…` 2.1 s.
