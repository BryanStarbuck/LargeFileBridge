// Local Kubo/IPFS client over the HTTP RPC (knowledge/ipfs.mdx). Uses fetch, never `curl`.
// Enforces the only-our-content rule: Provide.Strategy = pinned (the modern key; NEVER re-add the
// deprecated Reprovider block — it FATAL-s Kubo 0.42+ on start), no public/recursive gateway.
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IpfsHealth, IpfsPinType } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { bumpTopicThrottled, IPFS_TOPIC } from "../events/state-events.service.js";
import { log } from "../../shared/logging.js";

function apiBase(): string {
  const addr = getAppConfig().ipfs.api_addr; // e.g. /ip4/127.0.0.1/tcp/5001
  const m = addr.match(/\/ip4\/([\d.]+)\/tcp\/(\d+)/);
  const host = m ? m[1] : "127.0.0.1";
  const port = m ? m[2] : "5001";
  return `http://${host}:${port}/api/v0`;
}

// Short cap for cheap control calls (id/health, config, pin checks) so daemon-down detection stays
// fast. Data-transfer ops whose duration scales with file size (e.g. `add`) MUST override this —
// pass `timeoutMs: 0` to disable the wall-clock cap entirely (see addFile).
const RPC_TIMEOUT_MS = 15000;

async function rpc(
  cmd: string,
  opts: {
    query?: Record<string, string>;
    args?: string[];
    body?: FormData;
    // Per-call wall-clock timeout in ms. Defaults to the short RPC_TIMEOUT_MS. Use 0 to disable the
    // cap for large data transfers (an aborted `add` of a multi-GB video is the bug this fixes).
    timeoutMs?: number;
  } = {},
) {
  const params = new URLSearchParams(opts.query);
  for (const a of opts.args ?? []) params.append("arg", a); // repeated ?arg=…&arg=…
  const qs = params.toString() ? `?${params.toString()}` : "";
  const url = `${apiBase()}/${cmd}${qs}`;
  const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;
  const ctrl = new AbortController();
  // timeoutMs <= 0 means "no timeout": don't arm the aborter at all (used by size-scaled ops like add).
  const t = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, { method: "POST", body: opts.body, signal: ctrl.signal });
    if (!res.ok) throw new Error(`ipfs ${cmd} -> ${res.status} ${await res.text()}`);
    return res;
  } finally {
    if (t) clearTimeout(t);
  }
}

// ── Liveness for LONG-RUNNING IPFS work: idle time, not wall-clock time ──────────────────────────────
// A `pin/add` that must FETCH a multi-hundred-MB DAG from a peer, a `pin/ls` over a large pinset, and a
// `cat` of a big video all legitimately run for minutes — a wall clock sized for a control call kills
// them mid-flight ("This operation was aborted"), which silently breaks the product promise that a file
// is held on this computer. These ops therefore get NO total-duration cap. What they get instead is a
// STALL watchdog: the deadline resets on every byte of progress, so a transfer that is still moving is
// never cut off, while one that has genuinely wedged (dead peer, hung daemon) still fails instead of
// pinning a limiter slot forever.
//
// Each call builds its OWN controller here. Nothing is shared or reused across calls (one abort must
// never take down an unrelated in-flight op), and NO request-scoped signal is ever threaded into this
// layer — background/scheduled pin work must not die because a browser tab navigated away.
interface StallGuard {
  readonly signal: AbortSignal;
  /** Report progress — restarts the idle countdown. */
  touch(): void;
  /** Stop the watchdog (always call in a `finally`). */
  clear(): void;
  /** True when WE aborted for lack of progress (vs. any other abort). */
  readonly stalled: boolean;
}

function stallGuard(stallMs: number): StallGuard {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let stalled = false;
  return {
    signal: ctrl.signal,
    touch() {
      if (ctrl.signal.aborted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        ctrl.abort(); // default AbortError, so isAbortError() below still recognizes it
      }, stallMs);
      timer.unref?.(); // a watchdog must never hold the process open
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    get stalled() {
      return stalled;
    },
  };
}

/** Did this failure come from an abort (ours or the runtime's)? Retryable; a protocol error is not. */
const isAbortError = (e: unknown): boolean =>
  (e as Error)?.name === "AbortError" || /abort/i.test((e as Error)?.message ?? "");

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** Backoff before retrying an aborted/stalled op. `LFB_IPFS_RETRY_MS` shortens it (tests only). */
const retryDelayMs = (baseMs: number, attempt: number): number =>
  (Number(process.env.LFB_IPFS_RETRY_MS) || baseMs) * attempt;

/** Read a WHATWG response body as NDJSON, touching the stall guard on every chunk. Yields whole lines. */
async function* ndjsonLines(res: Response, guard: StallGuard): AsyncGenerator<string> {
  if (!res.body) {
    const text = await res.text();
    for (const line of text.split("\n")) if (line.trim()) yield line;
    return;
  }
  let buf = "";
  for await (const chunk of Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])) {
    guard.touch(); // progress — reset the idle countdown
    buf += Buffer.from(chunk as Buffer).toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
  if (buf.trim()) yield buf;
}

export async function health(): Promise<IpfsHealth> {
  try {
    await rpc("id");
    return "ok";
  } catch (e) {
    // The daemon being off is routine, not a fault — keep it out of error.err (debug only).
    log.debug("ipfs", `health probe unreachable: ${(e as Error).message}`);
    return "unreachable";
  }
}

export async function peerId(): Promise<string | null> {
  try {
    const res = await rpc("id");
    const json = (await res.json()) as { ID?: string };
    return json.ID ?? null;
  } catch (e) {
    log.debug("ipfs", `peerId unavailable: ${(e as Error).message}`);
    return null;
  }
}

/** Add a file and pin it recursively; returns its root CID (ipfs.mdx §3). */
export async function addFile(absPath: string): Promise<string> {
  try {
    // fs.openAsBlob streams the file rather than buffering it whole into memory.
    const blob = await (fs as unknown as { openAsBlob(p: string): Promise<Blob> }).openAsBlob(absPath);
    const form = new FormData();
    // Use the BASENAME, never the absolute path. Kubo's HTTP `add` treats a slashed multipart filename as a
    // directory tree and WRAPS the file in one node per path segment, returning the WRAPPER-dir CID (which
    // also embeds this machine's home path — non-portable across computers, and not `cat`-able as a file).
    // A bare basename adds the single file and returns the FILE's own CID, exactly like the CLI
    // (knowledge/ipfs.mdx §5.1). This is the CID that must be pinned, recorded, and fetched.
    form.append("file", blob, path.basename(absPath));
    // `add` uploads the whole file; its duration scales with file size (a 1.4 GB video far exceeds the
    // 15s control-call cap). Disable the wall-clock timeout (timeoutMs: 0) so large media can finish —
    // the pin limiter bounds concurrency, so this can't stampede the daemon.
    const res = await rpc("add", { query: { pin: "true", "cid-version": "1" }, body: form, timeoutMs: 0 });
    const text = await res.text();
    // add streams NDJSON; the final line has the root entry.
    const lines = text.trim().split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]) as { Hash?: string };
    if (!last.Hash) throw new Error("ipfs add returned no CID");
    return last.Hash;
  } catch (e) {
    // A failed add/pin is a real fault (file gone, bad JSON, daemon error) — record it, then rethrow
    // so the caller still sees the failure.
    log.error("ipfs", `add ${absPath} failed: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * The UnixFS node type of a CID ("file" | "directory" | null when the node can't be read). Metadata only —
 * `files/stat` reads the root block, moves no file bytes. Best-effort: an unresolvable CID yields null so
 * callers fall through to their normal error path instead of inventing a verdict.
 */
async function dagNodeType(cid: string): Promise<"file" | "directory" | null> {
  try {
    const res = await rpc("files/stat", { args: [`/ipfs/${cid}`] });
    const json = (await res.json()) as { Type?: string };
    return json.Type === "directory" ? "directory" : json.Type === "file" ? "file" : null;
  } catch (e) {
    log.debug("ipfs", `dagNodeType unavailable for ${cid}: ${(e as Error).message}`);
    return null;
  }
}

/** One directory listing (`ls`) as {name, hash} links; [] when the CID lists nothing / can't be read. */
async function lsLinks(cid: string): Promise<Array<{ name: string; hash: string }>> {
  const res = await rpc("ls", { args: [cid] });
  const json = (await res.json()) as {
    Objects?: Array<{ Links?: Array<{ Name?: string; Hash?: string }> }>;
  };
  return (json.Objects ?? [])
    .flatMap((o) => o.Links ?? [])
    .filter((l): l is { Name: string; Hash: string } => !!l.Hash)
    .map((l) => ({ name: l.Name ?? "", hash: l.Hash }));
}

// A wrapper chain is one node per path segment (`bryan/BGit/…/videos/clip.mp4`), so allow a generous but
// finite descent — a cycle or a genuine deep tree must not spin forever.
const MAX_WRAPPER_DEPTH = 24;

/**
 * Resolve a recorded CID to the CID of the actual FILE it denotes — the fix for the "this dag node is a
 * directory" retry loop (thousands of identical failures/day, and the file never syncing).
 *
 * WHY THIS EXISTS. Kubo's HTTP `add` treats a SLASHED multipart filename as a directory tree: it wraps the
 * file in one UnixFS directory per path segment and returns the WRAPPER-dir CID. `addFile` now sends only the
 * basename (see above), but manifests written before that fix still carry wrapper CIDs — and `ipfs cat` on a
 * directory node can NEVER work, so every sync cycle re-tried it forever. We walk the wrapper chain down to
 * the file instead: at each level take the child whose name matches `basename`, else the only child. Callers
 * record the resolved CID back into the manifest so the wrong CID stops being retried (self-healing).
 *
 * Returns `cid` unchanged when it is already a file (or the node type can't be read — then the caller's own
 * `cat`/`pin` reports the real fault). THROWS only when the node IS a directory but no single file can be
 * picked out of it — an honest "this recorded CID does not denote one file".
 */
export async function resolveFileCid(cid: string, basename?: string): Promise<string> {
  let cur = cid;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth++) {
    if ((await dagNodeType(cur)) !== "directory") return cur; // a file (or unreadable) — nothing to unwrap
    const links = await lsLinks(cur);
    const named = basename ? links.find((l) => l.name === basename) : undefined;
    const next = named ?? (links.length === 1 ? links[0] : undefined);
    if (!next) {
      throw new Error(
        `CID ${cid} is a directory node with ${links.length} entries and no child named ${basename ?? "(unknown)"} — cannot resolve it to a single file`,
      );
    }
    cur = next.hash;
  }
  throw new Error(`CID ${cid} nests directories deeper than ${MAX_WRAPPER_DEPTH} levels — refusing to descend further`);
}

/**
 * Materialize a file's bytes by CID to `destPath` — the byte side of "fetch" (pin_process.mdx / storage.mdx
 * §9). Streams the HTTP RPC `cat` to a temp file, then renames it into place atomically, creating parent
 * dirs. No 15s abort: large media legitimately take a while; the caller bounds concurrency via the pin
 * limiter. A partial download is cleaned up, never left as a truncated final file.
 *
 * The CID is resolved through `resolveFileCid` first, so a legacy WRAPPER-directory CID fetches the file
 * inside it instead of failing "this dag node is a directory" on every sync forever. RETURNS the CID whose
 * bytes actually landed — callers persist it back into the manifest to heal the bad record.
 */
const CAT_STALL_MS = 10 * 60_000; // 10 min with no bytes arriving ⇒ the transfer is dead, not slow

export async function catToFile(cid: string, destPath: string): Promise<string> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.lfb-fetch-${process.pid}-${Date.now()}.tmp`;
  let guard: StallGuard | undefined;
  try {
    // Unwrap a legacy wrapper-directory CID to the file inside it (see resolveFileCid). Inside the try so a
    // resolution failure still lands in the fault trail like any other fetch failure.
    const fileCid = await resolveFileCid(cid, path.basename(destPath));
    if (fileCid !== cid) log.info("ipfs", `cid ${cid} is a wrapper directory — fetching file ${fileCid} for ${destPath}`);
    const url = `${apiBase()}/cat?arg=${encodeURIComponent(fileCid)}`;
    // Stall watchdog, NOT a wall clock (see stallGuard): a 4 GB video may stream for an hour and must not
    // be aborted for taking long — but a transfer whose peer vanished must not hold a limiter slot forever.
    guard = stallGuard(CAT_STALL_MS);
    guard.touch();
    const res = await fetch(url, { method: "POST", signal: guard.signal });
    if (!res.ok || !res.body) {
      throw new Error(`ipfs cat ${fileCid} -> ${res.status} ${res.ok ? "empty body" : await res.text()}`);
    }
    // res.body is a WHATWG ReadableStream; adapt it to a Node stream and pipe to disk without buffering.
    // The pass-through in the middle exists only to feed the stall guard on every chunk that lands.
    const ticker = new Transform({
      transform(chunk, _enc, cb) {
        guard?.touch();
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      ticker,
      fs.createWriteStream(tmp),
      { signal: guard.signal },
    );
    fs.renameSync(tmp, destPath);
    return fileCid;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp already gone — ignore */
    }
    const why = guard?.stalled ? ` (no bytes for ${CAT_STALL_MS}ms — transfer stalled)` : "";
    log.error("ipfs", `cat ${cid} -> ${destPath} failed${why}: ${(e as Error).message}`);
    throw e;
  } finally {
    guard?.clear();
  }
}

// `pin/add` is NOT a control call. When the CID's blocks are not already local it FETCHES the entire DAG
// from a peer over the network — for the videos this product exists to sync that is hundreds of MB and
// many minutes. It was running on the 15s control-call cap, which aborted it mid-transfer: "pin add
// failed … This operation was aborted", i.e. the file was NOT held on this computer while the pin pass
// moved on. No wall clock now; a stall watchdog fed by Kubo's own progress stream instead.
const PIN_ADD_STALL_MS = 10 * 60_000; // 10 min with ZERO progress ⇒ genuinely wedged, not merely slow
const PIN_ADD_ATTEMPTS = 3; // an aborted/stalled pin is RETRIED — never silently accepted
const PIN_ADD_RETRY_MS = 5_000;

/**
 * One `pin/add` attempt with progress-based liveness.
 *
 * `progress=true` makes Kubo stream `{"Progress":N}` records while it fetches, which is what feeds the
 * stall guard — and the terminal `{"Pins":[…]}` record is the ONLY evidence the pin actually landed.
 * The old code discarded the body entirely, so a mid-stream Kubo failure (reported as a trailer record
 * on an already-200 response) was read as success and the CID was recorded as pinned here when it was
 * not. Absence of the `Pins` record is now a failure.
 */
async function pinAddOnce(cid: string): Promise<void> {
  const guard = stallGuard(PIN_ADD_STALL_MS);
  guard.touch();
  try {
    const url = `${apiBase()}/pin/add?arg=${encodeURIComponent(cid)}&recursive=true&progress=true`;
    const res = await fetch(url, { method: "POST", signal: guard.signal });
    if (!res.ok) throw new Error(`ipfs pin/add -> ${res.status} ${await res.text()}`);
    let confirmed = false;
    for await (const line of ndjsonLines(res, guard)) {
      let rec: { Pins?: string[]; Progress?: number; Message?: string };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue; // a partial/garbage line is not evidence either way
      }
      // Kubo signals a failure DISCOVERED AFTER the 200 header as a trailing {"Message":…} record.
      if (rec.Message && !rec.Pins) throw new Error(`ipfs pin/add: ${rec.Message}`);
      if (Array.isArray(rec.Pins) && rec.Pins.length > 0) confirmed = true;
    }
    if (!confirmed) throw new Error(`ipfs pin/add gave no confirmation for ${cid} (pin not established)`);
  } finally {
    guard.clear();
  }
}

/**
 * Pin a CID recursively, fetching its bytes if needed. Retries an abort/stall (a peer that went away, a
 * daemon busy with GC) before giving up, and THROWS when the pin did not land — callers must treat that
 * as "not pinned here" and never record a pin claim for it (see pin.service `runUnitPin`/`pullMissing`).
 */
export async function pinAdd(cid: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pinAddOnce(cid);
      bumpTopicThrottled(IPFS_TOPIC); // throttled — a pin pass adds per-file in bursts
      return;
    } catch (e) {
      const stalledOrAborted = isAbortError(e);
      if (stalledOrAborted && attempt < PIN_ADD_ATTEMPTS) {
        log.info(
          "ipfs",
          `pin add ${cid} stalled (no progress for ${PIN_ADD_STALL_MS}ms) on attempt ${attempt} — retrying`,
        );
        await delay(retryDelayMs(PIN_ADD_RETRY_MS, attempt));
        continue;
      }
      log.error("ipfs", `pin add failed for ${cid} after ${attempt} attempt(s): ${(e as Error).message}`);
      throw e;
    }
  }
}

export async function pinRm(cid: string): Promise<void> {
  try {
    await rpc("pin/rm", { args: [cid], query: { recursive: "true" } });
    bumpTopicThrottled(IPFS_TOPIC);
  } catch (e) {
    log.warn("ipfs", `pin rm failed for ${cid}: ${(e as Error).message}`);
  }
}

// ── CID canonicalization — the SAME block can wear different CID strings (knowledge/ipfs.mdx §5.1) ──
// `ipfs pin ls` is base-SENSITIVE: a block pinned as CIDv0 (`Qm…`) is reported "not pinned" when the same
// block is queried as its CIDv1 form (`bafy…`) — verified against a live daemon. So a RAW CID-string
// compare against the pinset is a real defect: it goes BLIND to a pin merely because of its base encoding
// (the "1255 invisible v0 pins" class). Every comparison of a CID against the pinset MUST canonicalize both
// sides to ONE form (CIDv1 base32) first. This bridges the ENCODING axis (v0↔v1 of the SAME multihash). It
// canNOT bridge the DAG-PROFILE axis (`--cid-version`/`--raw-leaves` change the multihash itself) — for that
// the bytes must be re-hashed (see contentPinnedCid). Dependency-free so it stays fully local (charter).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 lower, no padding (multibase 'b')

function base58btcDecode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    let carry = B58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error(`bad base58 char: ${ch}`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0); // leading-zero bytes
  return Uint8Array.from(bytes.reverse());
}

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of data) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Normalize any CID to its canonical CIDv1 base32 string so two encodings of the SAME block compare equal
 * (knowledge/ipfs.mdx §5.1). A CIDv0 is always base58btc(multihash) with an implied dag-pb (0x70) codec;
 * we re-wrap it as v1 (0x01) + dag-pb (0x70) + multihash and base32-encode with the multibase 'b' prefix.
 * Anything already CIDv1 (`bafy…`/`bafk…`) or unrecognized is returned unchanged (best-effort — never throws).
 */
export function canonicalCid(cid: string): string {
  try {
    if (!cid.startsWith("Qm")) return cid; // already CIDv1 (or a form we leave as-is)
    const mh = base58btcDecode(cid);
    const bytes = new Uint8Array(mh.length + 2);
    bytes[0] = 0x01; // CIDv1
    bytes[1] = 0x70; // dag-pb (a CIDv0 is always dag-pb)
    bytes.set(mh, 2);
    return "b" + base32Encode(bytes);
  } catch (e) {
    log.debug("ipfs", `canonicalCid passthrough for ${cid}: ${(e as Error).message}`);
    return cid;
  }
}

/** The local pinset as a Set of CANONICAL (CIDv1 base32) CIDs — the base-robust membership test the raw
 *  `new Set(pins.map(p => p.cid))` was silently getting wrong (knowledge/ipfs.mdx §5.1). Best-effort. */
export async function canonicalPinnedSet(): Promise<Set<string>> {
  return new Set((await listPins()).map((p) => canonicalCid(p.cid)));
}

export async function isPinned(cid: string): Promise<boolean> {
  try {
    // pin/ls is base-SENSITIVE, so a single-CID query can miss a same-block pin recorded in another base.
    // Compare CANONICALLY against the roots listing instead (knowledge/ipfs.mdx §5.1). Roots-only listing
    // is the cheap control-call the reconcile already relies on.
    const target = canonicalCid(cid);
    return (await listPins()).some((p) => canonicalCid(p.cid) === target);
  } catch (e) {
    log.debug("ipfs", `isPinned check failed for ${cid}: ${(e as Error).message}`);
    return false;
  }
}

/** Compute a file's CID WITHOUT storing or pinning it (`add --only-hash`), under one add profile. Streams the
 *  bytes to the daemon over loopback so it can hash them; nothing is written to the blockstore, nothing is
 *  pinned, no network. `query` selects the profile (e.g. { "cid-version": "1" }). */
async function addOnlyHash(absPath: string, query: Record<string, string>): Promise<string> {
  const blob = await (fs as unknown as { openAsBlob(p: string): Promise<Blob> }).openAsBlob(absPath);
  const form = new FormData();
  // Basename, NOT the absolute path — a slashed filename makes Kubo wrap the file in a directory tree and
  // return the wrapper CID instead of the file's own CID (see addFile / knowledge/ipfs.mdx §5.1).
  form.append("file", blob, path.basename(absPath));
  const res = await rpc("add", { query: { "only-hash": "true", ...query }, body: form, timeoutMs: 0 });
  const lines = (await res.text()).trim().split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]!) as { Hash?: string };
  if (!last.Hash) throw new Error("ipfs add --only-hash returned no CID");
  return last.Hash;
}

/**
 * The add PROFILES we re-hash a file under to recognize a foreign pin across the DAG-profile axis
 * (knowledge/ipfs.mdx §5.1 / pm/foreign_pin_discovery.mdx §2). Each profile is a set of `ipfs add` flags
 * that changes how the Merkle DAG is built, hence the multihash. This list is the SINGLE place to extend as
 * we learn other tools' defaults — it is deliberately a named constant, not inline, so foreign-pin discovery
 * grows by adding an entry here. We can only reproduce profiles KUBO can produce; a non-Kubo chunker/codec is
 * the honest limit (surfaced + logged on the IPFS page, never silently called "clear" — §2.1).
 *   • v1-raw-leaves    — our app standard (`--cid-version=1`, Kubo defaults raw-leaves=true) → `bafy…`
 *   • v0-dag-pb        — a legacy / manual `ipfs add` with no flags → CIDv0 dag-pb, no raw leaves → `Qm…`
 *   • v1-no-raw-leaves — `--cid-version=1 --raw-leaves=false` (dag-pb leaves under a v1 root)
 */
export const ADD_PROFILES: ReadonlyArray<{ label: string; query: Record<string, string> }> = [
  { label: "v1-raw-leaves", query: { "cid-version": "1" } },
  { label: "v0-dag-pb", query: { "cid-version": "0" } },
  { label: "v1-no-raw-leaves", query: { "cid-version": "1", "raw-leaves": "false" } },
];

/**
 * Like contentPinnedCid but also names WHICH profile matched (for the discovery record — foreign_pin_discovery
 * §5). Re-hashes the local bytes under each ADD_PROFILES entry (no store, no pin, no network) and tests each
 * canonicalized result against `pinned` (the kept-set — pins ∪ MFS roots, §2.2). First hit wins.
 * EXPENSIVE (a full byte read+hash per profile); callers MUST bound how often they invoke it — never on a
 * read hot path (foreign_pin_discovery §3 runs it in the background, size-pruned + cached).
 */
export async function contentPinnedCidDetailed(
  absPath: string,
  pinned?: Set<string>,
): Promise<{ cid: string; profile: string } | null> {
  let kept: Set<string>;
  try {
    kept = pinned ?? (await keptCidSet());
  } catch (e) {
    // Best-effort probe: an unreadable pinset (pin ls timeout) just means "no foreign pin recognized" —
    // the caller falls back to a normal add of the same bytes, which is safe (same profile → same CID).
    log.debug("ipfs", `contentPinnedCid kept-set unavailable: ${(e as Error).message}`);
    return null;
  }
  for (const { label, query } of ADD_PROFILES) {
    try {
      const cid = await addOnlyHash(absPath, query);
      if (kept.has(canonicalCid(cid))) return { cid, profile: label };
    } catch (e) {
      log.debug("ipfs", `contentPinnedCid probe (${label}) failed for ${absPath}: ${(e as Error).message}`);
    }
  }
  return null;
}

/**
 * Return the CID under which THIS FILE's exact bytes are ALREADY pinned on this node, or null — bridging the
 * DAG-PROFILE axis that canonicalCid cannot (knowledge/ipfs.mdx §5.1). See contentPinnedCidDetailed for the
 * profile set and the cost warning. This thin wrapper keeps the existing string|null callers (pin.service
 * foreign-profile adoption) unchanged.
 */
export async function contentPinnedCid(absPath: string): Promise<string | null> {
  return (await contentPinnedCidDetailed(absPath))?.cid ?? null;
}

/**
 * MFS root CIDs — the "kept but not in `pin ls`" content (knowledge/ipfs.mdx §3/§7): a file another tool
 * dropped into the Mutable File System is GC-protected (implicit pin) yet appears in NEITHER pin listing.
 * Folding these into the kept-set makes foreign-pin discovery see MFS-protected files too
 * (foreign_pin_discovery §2.2). Best-effort — MFS empty/unreadable just yields [].
 */
export async function listMfsRoots(): Promise<string[]> {
  try {
    const res = await rpc("files/ls", { args: ["/"], query: { long: "true" } });
    const json = (await res.json()) as { Entries?: Array<{ Hash?: string }> | null };
    return (json.Entries ?? []).map((e) => e.Hash).filter((h): h is string => !!h);
  } catch (e) {
    log.debug("ipfs", `listMfsRoots unavailable: ${(e as Error).message}`);
    return [];
  }
}

/** The kept-set: CANONICAL (CIDv1 base32) CIDs the node is keeping — explicit pins (recursive+direct) UNION
 *  MFS roots (§2.2). This is the superset a foreign-pin comparison must test against, not just `pin ls`. */
export async function keptCidSet(): Promise<Set<string>> {
  const [pins, mfs] = await Promise.all([listPins(), listMfsRoots()]);
  const set = new Set(pins.map((p) => canonicalCid(p.cid)));
  for (const cid of mfs) set.add(canonicalCid(cid));
  return set;
}

/**
 * Index kept CIDs by their on-disk cumulative size → the SIZE-PRUNE key for foreign-pin discovery
 * (foreign_pin_discovery §3). A DAG's cumulative size is the file size + a few hundred bytes of framing
 * (measured ~0.024% on a 2.3 MB video), so a file is a discovery candidate ONLY if some kept CID's size sits
 * just above the file size — letting us hash a handful of size-matched files instead of the whole repo.
 * Metadata-only (`files/stat` per CID, bounded concurrency); best-effort — unresolvable CIDs are skipped.
 */
export async function keptSizeIndex(): Promise<Map<number, string[]>> {
  const cids = [...(await keptCidSet())];
  const idx = new Map<number, string[]>();
  let next = 0;
  const workers = Array.from({ length: Math.min(8, cids.length) }, async () => {
    while (next < cids.length) {
      const cid = cids[next++]!;
      const size = await objectSize(cid);
      if (size != null) idx.set(size, [...(idx.get(size) ?? []), cid]);
    }
  });
  await Promise.all(workers);
  return idx;
}

// ── Reading the pinset (ipfs.mdx §6 — the scheduleTask's metadata-only read) ─
export interface Pin {
  cid: string;
  type: IpfsPinType;
}

// `pin/ls` ENUMERATES the whole pinset in one RPC, so its duration scales with pin count (and it can
// stall behind daemon GC or startup). ANY fixed wall clock is wrong here — it mis-fires precisely on the
// big pinsets this product produces, and an aborted enumeration makes the app's view of what is pinned
// WRONG, which drives every pin-truth surface in the UI. So: no total cap, a stall watchdog on the
// streamed records instead, and retries on an abort.
const PIN_LS_STALL_MS = 120_000; // 2 min with not one record arriving ⇒ the daemon is wedged
const PIN_LS_ATTEMPTS = 3;
const PIN_LS_RETRY_MS = 2_000;

/**
 * Enumerate ONE pin type with progress-based liveness. Asks Kubo for `stream=true` so pins arrive as
 * NDJSON records (`{"Cid":…,"Type":…}`) instead of one giant blob at the end — that is what lets the
 * stall guard tell "still enumerating" from "hung". Older daemons ignore `stream` and answer with a
 * single `{"Keys":{…}}` object, which this parses too.
 */
async function listPinsOfType(type: "recursive" | "direct"): Promise<Map<string, IpfsPinType>> {
  const guard = stallGuard(PIN_LS_STALL_MS);
  guard.touch();
  const out = new Map<string, IpfsPinType>();
  try {
    const url = `${apiBase()}/pin/ls?type=${type}&stream=true`;
    const res = await fetch(url, { method: "POST", signal: guard.signal });
    if (!res.ok) throw new Error(`ipfs pin/ls -> ${res.status} ${await res.text()}`);
    for await (const line of ndjsonLines(res, guard)) {
      let rec: { Cid?: string; Keys?: Record<string, { Type?: string }>; Message?: string };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      // A trailing {"Message":…} after a 200 is Kubo reporting a failure mid-enumeration. Never let that
      // return a PARTIAL list that reads as "these are all the pins" — the caller must see a failure.
      if (rec.Message && !rec.Cid && !rec.Keys) throw new Error(`ipfs pin/ls: ${rec.Message}`);
      if (rec.Cid) out.set(rec.Cid, type);
      for (const cid of Object.keys(rec.Keys ?? {})) out.set(cid, type); // legacy non-streaming shape
    }
  } finally {
    guard.clear();
  }
  return out;
}

/**
 * The local pinset as ground truth (`ipfs pin ls`). Lists only ROOT pins — recursive + direct —
 * and never the indirect blocks kept under a recursive root (ipfs.mdx §1). Metadata only: it names
 * CIDs and their pin type; it opens no file and moves no bytes.
 *
 * THROWS when either enumeration fails (after retries on a stall). It must never swallow a failure
 * and return a partial/empty list — a timeout masquerading as "no pins" made consumers (pin pass,
 * scanner, pull prompt) treat everything as pin-lost. Callers degrade to "pinset UNKNOWN", not empty.
 */
export async function listPins(): Promise<Pin[]> {
  const out = new Map<string, IpfsPinType>();
  for (const type of ["recursive", "direct"] as const) {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        for (const [cid, t] of await listPinsOfType(type)) if (!out.has(cid)) out.set(cid, t);
        break;
      } catch (e) {
        const elapsedMs = Date.now() - started;
        // Retry only on an abort/stall (a slow enumeration or a GC pause can clear up); any other fault
        // (daemon down, RPC error) won't improve on a retry — fail fast.
        if (isAbortError(e) && attempt < PIN_LS_ATTEMPTS) {
          log.info(
            "ipfs",
            `pin ls (${type}) stalled after ${elapsedMs}ms (no records for ${PIN_LS_STALL_MS}ms) — retry ${attempt + 1}/${PIN_LS_ATTEMPTS}`,
          );
          await delay(retryDelayMs(PIN_LS_RETRY_MS, attempt));
          continue;
        }
        log.warn(
          "ipfs",
          `pin ls (${type}) failed after ${elapsedMs}ms on attempt ${attempt} ` +
            `(stall cap ${PIN_LS_STALL_MS}ms; ${out.size} pins read from earlier types): ${(e as Error).message}`,
        );
        throw new Error(`ipfs pin ls (${type}) failed: ${(e as Error).message}`);
      }
    }
  }
  return [...out].map(([cid, type]) => ({ cid, type }));
}

/**
 * Best-effort cumulative on-disk size of a CID's DAG. Uses `files/stat` (`object/stat` is removed in
 * modern Kubo); reads the whole block DAG including framing, so it matches what the pin actually costs.
 * Returns null when unknown (e.g. the node can't resolve the CID).
 */
export async function objectSize(cid: string): Promise<number | null> {
  try {
    const res = await rpc("files/stat", { args: [`/ipfs/${cid}`] });
    const json = (await res.json()) as { CumulativeSize?: number };
    return typeof json.CumulativeSize === "number" ? json.CumulativeSize : null;
  } catch (e) {
    // Best-effort size — an unresolvable CID is expected; keep it out of the fault trail.
    log.debug("ipfs", `objectSize unavailable for ${cid}: ${(e as Error).message}`);
    return null;
  }
}

// ── Node metrics for the dashboard (ipfs_ui.mdx §4/§5.2) — all best-effort, all nullable ─────
/** Kubo version string (e.g. "0.29.0") over RPC; null when unreachable. */
export async function version(): Promise<string | null> {
  try {
    const res = await rpc("version");
    const json = (await res.json()) as { Version?: string };
    return json.Version ?? null;
  } catch (e) {
    log.debug("ipfs", `version unavailable: ${(e as Error).message}`);
    return null;
  }
}

export interface RepoStat {
  repoSizeBytes: number | null;
  storageMaxBytes: number | null;
  numObjects: number | null;
  repoPath: string | null;
}

/** `repo/stat` — bytes on disk, the GC cap, block count, and repo path. Any field may be null. */
export async function repoStat(): Promise<RepoStat> {
  try {
    const res = await rpc("repo/stat");
    const json = (await res.json()) as {
      RepoSize?: number;
      StorageMax?: number;
      NumObjects?: number;
      RepoPath?: string;
    };
    return {
      repoSizeBytes: typeof json.RepoSize === "number" ? json.RepoSize : null,
      storageMaxBytes: typeof json.StorageMax === "number" ? json.StorageMax : null,
      numObjects: typeof json.NumObjects === "number" ? json.NumObjects : null,
      repoPath: json.RepoPath ?? null,
    };
  } catch (e) {
    log.debug("ipfs", `repoStat unavailable: ${(e as Error).message}`);
    return { repoSizeBytes: null, storageMaxBytes: null, numObjects: null, repoPath: null };
  }
}

/** Count of currently-connected swarm peers (`swarm/peers`); null when unreachable. */
export async function swarmPeerCount(): Promise<number | null> {
  try {
    const res = await rpc("swarm/peers");
    const json = (await res.json()) as { Peers?: unknown[] };
    return Array.isArray(json.Peers) ? json.Peers.length : 0;
  } catch (e) {
    log.debug("ipfs", `swarmPeerCount unavailable: ${(e as Error).message}`);
    return null;
  }
}

export interface Bandwidth {
  totalIn: number | null;
  totalOut: number | null;
  rateIn: number | null;
  rateOut: number | null;
}

/** Cumulative + instantaneous bandwidth (`stats/bw`); best-effort, may be all null. */
export async function bandwidth(): Promise<Bandwidth> {
  try {
    const res = await rpc("stats/bw");
    const json = (await res.json()) as {
      TotalIn?: number;
      TotalOut?: number;
      RateIn?: number;
      RateOut?: number;
    };
    return {
      totalIn: typeof json.TotalIn === "number" ? json.TotalIn : null,
      totalOut: typeof json.TotalOut === "number" ? json.TotalOut : null,
      rateIn: typeof json.RateIn === "number" ? json.RateIn : null,
      rateOut: typeof json.RateOut === "number" ? json.RateOut : null,
    };
  } catch (e) {
    log.debug("ipfs", `bandwidth unavailable: ${(e as Error).message}`);
    return { totalIn: null, totalOut: null, rateIn: null, rateOut: null };
  }
}

/** Ask the daemon to shut itself down (RPC `shutdown`). Used by the on/off toggle (ipfs_ui.mdx §6). */
export async function shutdownDaemon(): Promise<void> {
  await rpc("shutdown");
}

export interface GatewaySummary {
  enabled: boolean;
  localOnly: boolean;
  url: string | null;
  addr: string | null;
}

/** Turn a `/ip4/HOST/tcp/PORT` multiaddr into an http URL, or null when it can't be parsed. */
function multiaddrToUrl(addr: string): string | null {
  const m = addr.match(/\/ip[46]\/([^/]+)\/tcp\/(\d+)/);
  if (!m) return null;
  const host = m[1] === "::1" || m[1] === "0.0.0.0" ? "127.0.0.1" : m[1];
  return `http://${host}:${m[2]}`;
}

/** Gateway posture for the dashboard: is it on, loopback-only, and at what URL. */
export async function gatewaySummary(): Promise<GatewaySummary> {
  // localOnly means "not exposing a PUBLIC gateway": NO gateway at all is the safest state and counts
  // as local-only (knowledge/ipfs.mdx §6/§8). A gateway bound only to loopback is also local-only.
  const summarize = (list: string[]): GatewaySummary => {
    const addrs = list.filter(Boolean);
    const enabled = addrs.length > 0;
    const localOnly = !enabled || addrs.every((a) => LOOPBACK.test(a));
    const addr = addrs[0] ?? null;
    return { enabled, localOnly, url: addr ? multiaddrToUrl(addr) : null, addr };
  };
  try {
    // Authoritative: the LIVE node config. An empty value means it serves no gateway — do NOT fall
    // back to the app-config default here (that would advertise a gateway URL that isn't served).
    const gwAddr = await getConfigKey("Addresses.Gateway");
    const list = Array.isArray(gwAddr) ? gwAddr.map(String) : gwAddr ? [String(gwAddr)] : [];
    return summarize(list);
  } catch (e) {
    // Node unreachable — fall back to the configured intent just for display.
    log.debug("ipfs", `gatewaySummary falling back to config (node unreachable): ${(e as Error).message}`);
    const cfgAddr = getAppConfig().ipfs.gateway_addr;
    return summarize(cfgAddr ? [cfgAddr] : []);
  }
}

/** A snapshot of the node's only-our-content posture for the IPFS page card (ipfs.mdx §3). */
export interface NodePosture {
  reprovideStrategy: "pinned" | "roots" | "all";
  gatewayLocalOnly: boolean;
  gcOn: boolean;
  // The charter bans becoming "a gateway that bounces or caches other people's content OR TRAFFIC".
  // Gateway + reprovide cover CONTENT. These two cover TRAFFIC — and both default to ON in Kubo, so
  // silence here is non-compliance, not safety (ipfs.mdx §3.2).
  relayServiceOff: boolean; // we do NOT relay other peers' traffic (Swarm.RelayService.Enabled=false)
  dhtClientOnly: boolean; // we do NOT answer other peers' DHT queries (Routing.Type=autoclient)
}

const LOOPBACK = /\/ip4\/127\.0\.0\.1\/|\/ip6\/::1\//;

/**
 * Read the live node config for the card. Reports ONLY what the node itself says — app config is our
 * INTENT and is never substituted for evidence about the node (see the unreachable branch below).
 */
export async function nodePosture(): Promise<NodePosture> {
  try {
    const strat = await readReprovideStrategy();
    // NEVER READ SILENCE AS SAFETY (charter; ipfs.mdx §3.2). An UNSET strategy is not "whatever we intended"
    // — it is Kubo's own default, which is `all`: the node announces EVERY block it holds, including
    // incidentally-cached third-party content. Falling back to `cfg.ipfs.reprovide_strategy` (default
    // "pinned") made an untouched node render "Reprovide: pinned ✓" and pass `compliant` while it was in
    // fact announcing everything — the exact silence-is-safety bug §3.2 exists to kill, surviving on the
    // CONTENT vector after it was fixed on the two TRAFFIC vectors. App config is our INTENT; only the
    // node's live config is the truth, and when the node is silent the truth is Kubo's default.
    const reprovideStrategy =
      strat === "pinned" || strat === "roots" || strat === "all" ? (strat as "pinned" | "roots" | "all") : "all";
    const gwAddr = await getConfigKey("Addresses.Gateway");
    const gateways = (Array.isArray(gwAddr) ? gwAddr.map(String) : gwAddr ? [String(gwAddr)] : []).filter(Boolean);
    // NO gateway is the safest state (nothing served publicly) → local-only. A configured gateway is
    // local-only iff every address is loopback (knowledge/ipfs.mdx §6/§8).
    const gatewayLocalOnly = gateways.length === 0 || gateways.every((a) => LOOPBACK.test(a));
    // Best-effort: a non-empty GCPeriod means GC is configured to reclaim incidental third-party
    // cache (knowledge/ipfs.mdx §4). RPC can't observe whether the daemon was launched with
    // --enable-gc, so this reads the intent, not the runtime flag.
    const gcPeriod = String((await getConfigKey("Datastore.GCPeriod")) ?? "").trim();
    return {
      reprovideStrategy,
      gatewayLocalOnly,
      gcOn: gcPeriod.length > 0,
      relayServiceOff: await readRelayServiceOff(),
      dhtClientOnly: await readDhtClientOnly(),
    };
  } catch (e) {
    // Node unreachable — CLAIM NOTHING (ipfs.mdx §3.2; ipfs_ui.mdx §13.1 "don't report what you didn't
    // verify"). We cannot read ANY vector, so none may render a reassuring ✓. Kubo's defaults are the
    // NON-compliant direction on every one of the four, and our app config is our INTENT, never evidence
    // about the node: `reprovide_strategy` defaults to "pinned" and `public_gateway` to false, so reporting
    // intent here painted a fully green card for a node we could not even reach. The rule was already
    // applied to the two traffic vectors; it applies to all four.
    log.debug("ipfs", `nodePosture cannot read the node (unreachable): ${(e as Error).message}`);
    return {
      reprovideStrategy: "all",
      gatewayLocalOnly: false,
      gcOn: false,
      relayServiceOff: false,
      dhtClientOnly: false,
    };
  }
}

/**
 * Are we refusing to relay OTHER peers' traffic? (`Swarm.RelayService.Enabled`)
 *
 * DEFAULT IS ON. Kubo docs: "Starting with go-ipfs v0.11, every publicly dialable go-ipfs will start a
 * limited RelayService" — i.e. an unset/`{}` RelayService block means we ARE a circuit-relay v2 server
 * for strangers. So `undefined` resolves to NOT compliant; only an explicit `false` counts.
 *
 * Scope, stated honestly: the limited v2 relay carries other peers' low-bandwidth connection traffic
 * (identify/ping/holepunch) — NOT their file bytes (bitswap needs a v1 relay). It is still "traffic
 * bounced through our machine", which the charter names outright, so we turn it off.
 */
async function readRelayServiceOff(): Promise<boolean> {
  const v = await getConfigKey("Swarm.RelayService.Enabled");
  return v === false;
}

/**
 * Are we refusing to serve OTHER peers' DHT queries? (`Routing.Type`)
 *
 * DEFAULT IS `auto`, which becomes a DHT SERVER once we're publicly dialable — storing and serving
 * provider records for content that isn't ours. `autoclient` keeps every ability we actually need
 * (finding peers, fetching our files, AND publishing provider records so our OWN pinned files stay
 * findable) while never answering someone else's query.
 */
async function readDhtClientOnly(): Promise<boolean> {
  const v = String((await getConfigKey("Routing.Type")) ?? "").toLowerCase();
  return v === "autoclient" || v === "dhtclient";
}

// ── Compliance (knowledge/ipfs.mdx §6) ──────────────────────────────────────
async function getConfigKey(key: string): Promise<unknown> {
  try {
    const res = await rpc("config", { args: [key] });
    const json = (await res.json()) as { Value?: unknown };
    return json.Value;
  } catch (e) {
    // Kubo answers HTTP 500 "<key> not found" for a config key that is simply unset.
    // That is "unset", not a fault — return undefined so callers see it as unset.
    if (/not found/i.test((e as Error).message)) return undefined;
    throw e;
  }
}

async function setConfigKey(key: string, value: string): Promise<void> {
  await rpc("config", { args: [key, value] });
}

/**
 * The node's effective announce strategy, reading the MODERN key first. Kubo renamed
 * `Reprovider.Strategy` → `Provide.Strategy` and (0.42+) REMOVED the old one — a lingering `Reprovider`
 * block makes the daemon FATAL on start (ipfs_ui.mdx §14). So we read `Provide.Strategy` first and only
 * fall back to the deprecated key for older builds. Returns "" when neither is set.
 */
async function readReprovideStrategy(): Promise<string> {
  const provide = String((await getConfigKey("Provide.Strategy")) ?? "").toLowerCase();
  if (provide) return provide;
  return String((await getConfigKey("Reprovider.Strategy")) ?? "").toLowerCase();
}

/**
 * True if the running node announces only our own pinned content, runs no public gateway, AND carries none
 * of other people's traffic — ALL FOUR charter vectors (ipfs.mdx §3.2).
 *
 * ONE SOURCE OF TRUTH. This used to check the reprovide strategy ALONE, while `nodeStatus()`
 * (ipfs-node.service.ts) and `computeIpfsPage()` checked all four — so the Settings page, which reads this,
 * would render a green "compliant ✓" for a node that was relaying strangers' connections and serving their
 * DHT queries. Two compliance predicates that disagree is worse than either one: the user sees whichever
 * page happens to be kinder. The verdict now folds the same four vectors everywhere, from the same posture.
 */
export async function isCompliant(): Promise<boolean> {
  try {
    const p = await nodePosture();
    // `nodePosture` already resolves an UNSET strategy to Kubo's real default ("all" → non-compliant) and
    // never reads our app-config intent as if it were the node's state.
    const contentOnlyOurs = p.reprovideStrategy === "pinned" || p.reprovideStrategy === "roots";
    return contentOnlyOurs && p.gatewayLocalOnly && p.relayServiceOff && p.dhtClientOnly;
  } catch (e) {
    // Node unreachable -> we can't verify; treat as non-blocking (health handles the red pill).
    log.debug("ipfs", `compliance check skipped (node unreachable): ${(e as Error).message}`);
    return false;
  }
}

/**
 * Bring the node into compliance with the charter's only-our-content / no-relay default.
 *
 * SCOPE OF THE OPT-OUT (charter; ipfs.mdx §3.1/§3.2). The `public_gateway` setting opts this machine out of
 * ONE thing — the loopback-only GATEWAY — and nothing else. It used to `return` from this whole function,
 * so flipping that one setting silently disabled relay AND DHT AND reprovide enforcement too: the machine
 * stayed a circuit-relay v2 server and a DHT server for strangers (both default ON in Kubo), the card
 * correctly showed red because the READ path is independent, and the Fix button became a no-op. Serving our
 * own content on a public gateway is a choice a user can make; carrying OTHER people's traffic is the thing
 * the charter bans outright, and the two were never the same decision.
 */
export async function enforceCompliance(): Promise<void> {
  const cfg = getAppConfig();
  try {
    const strat = await readReprovideStrategy();
    if (strat !== "pinned" && strat !== "roots") {
      // CRITICAL: write the MODERN `Provide.Strategy`, NOT `Reprovider.Strategy`. On Kubo 0.42+ setting
      // `Reprovider.Strategy` RE-CREATES the deprecated `Reprovider` block, which makes the daemon FATAL
      // on the next start — i.e. enforcing "compliance" would silently re-arm the exact crash this
      // feature exists to fix (ipfs_ui.mdx §14). We only fall back to the old key on a build that lacks
      // `Provide` entirely.
      try {
        await setConfigKey("Provide.Strategy", cfg.ipfs.reprovide_strategy);
        log.info("ipfs", `Set Provide.Strategy = ${cfg.ipfs.reprovide_strategy} (only-our-content).`);
      } catch (e) {
        if (/not found/i.test((e as Error).message)) {
          // Old Kubo without `Provide` — fall back to the legacy key (safe there; it isn't removed yet).
          try {
            await setConfigKey("Reprovider.Strategy", cfg.ipfs.reprovide_strategy);
            log.info("ipfs", `Set legacy Reprovider.Strategy = ${cfg.ipfs.reprovide_strategy} (older Kubo).`);
          } catch (e2) {
            if (/not found/i.test((e2 as Error).message)) {
              log.info("ipfs", "Neither Provide.Strategy nor Reprovider.Strategy is settable — skipping enforcement.");
            } else {
              throw e2;
            }
          }
        } else {
          throw e;
        }
      }
    }
    // Restore the gateway to loopback-only (charter no-relay policy; ipfs.mdx §3.1 / ipfs_ui.mdx §8):
    // a Fix must undo any public/recursive gateway, not just the reprovide strategy. Only rewrite when
    // the live config actually exposes a non-loopback gateway, so a user's custom loopback PORT is kept.
    try {
      const gwAddr = await getConfigKey("Addresses.Gateway");
      const gateways = (Array.isArray(gwAddr) ? gwAddr.map(String) : gwAddr ? [String(gwAddr)] : []).filter(Boolean);
      const exposesPublic = gateways.some((a) => !LOOPBACK.test(a));
      // THE OPT-OUT LIVES HERE, AND ONLY HERE — it governs the gateway rebind, never the traffic vectors below.
      if (cfg.ipfs.public_gateway) {
        if (exposesPublic) {
          log.warn("ipfs", "public_gateway is ON — leaving the public gateway in place (machine opted out of the loopback-only default).");
        }
      } else if (exposesPublic) {
        // Kubo's Addresses.Gateway is a single multiaddr string; rebind it to our loopback default.
        await setConfigKey("Addresses.Gateway", cfg.ipfs.gateway_addr);
        log.info("ipfs", `Rebound Addresses.Gateway = ${cfg.ipfs.gateway_addr} (loopback-only, no public gateway).`);
      }
    } catch (e) {
      if (/not found/i.test((e as Error).message)) {
        log.info("ipfs", "Addresses.Gateway not settable on this Kubo build — skipping gateway enforcement.");
      } else {
        throw e;
      }
    }

    // ── Don't bounce OTHER people's traffic through this machine (charter no-relay policy) ──
    // The gateway/reprovide fixes above stop us serving other people's CONTENT. These two stop us
    // carrying their TRAFFIC — the charter bans both, and BOTH default to ON in Kubo, so a node we
    // never touched is non-compliant by default. That is why this is enforced, not just measured.
    if (!(await readRelayServiceOff())) {
      // `Swarm.RelayService.Enabled` defaults to true for any publicly dialable node (Kubo ≥0.11):
      // we become a circuit-relay v2 server for strangers without ever opting in.
      await setBoolConfigKey("Swarm.RelayService.Enabled", false, "relay service");
    }
    if (!(await readDhtClientOnly())) {
      // `Routing.Type` defaults to `auto` → DHT SERVER when publicly dialable, answering other peers'
      // routing queries. `autoclient` still finds peers and still publishes OUR provider records, so
      // our own pinned files stay findable from our other computers — we just stop serving strangers.
      await setConfigKey("Routing.Type", "autoclient");
      log.info("ipfs", "Set Routing.Type = autoclient (we don't serve other peers' DHT queries).");
    }
  } catch (e) {
    log.warn("ipfs", `Could not enforce compliance: ${(e as Error).message}`);
  }
}

/**
 * Write a BOOLEAN config key. Kubo's `config` RPC takes values as strings unless told otherwise, and
 * REJECTS a bare "false" for a flag: `failed to unmarshal "\"false\"" into a flag: must be
 * null/undefined, true, or false (maybe use --json?)`. That error would be swallowed by
 * enforceCompliance's catch and logged as a warning — leaving the relay ON while nothing obvious
 * broke. `?json=true` is what makes it a real boolean (verified against a live Kubo 0.42 daemon).
 */
async function setBoolConfigKey(key: string, value: boolean, label: string): Promise<void> {
  try {
    await rpc("config", { args: [key, String(value)], query: { json: "true" } });
    log.info("ipfs", `Set ${key} = ${value} (${label} — only-our-content).`);
  } catch (e) {
    if (/not found/i.test((e as Error).message)) {
      log.info("ipfs", `${key} not settable on this Kubo build — skipping ${label} enforcement.`);
      return;
    }
    throw e;
  }
}
