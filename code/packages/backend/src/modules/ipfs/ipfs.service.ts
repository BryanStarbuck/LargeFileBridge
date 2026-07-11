// Local Kubo/IPFS client over the HTTP RPC (knowledge/ipfs.mdx). Uses fetch, never `curl`.
// Enforces the only-our-content rule: Provide.Strategy = pinned (the modern key; NEVER re-add the
// deprecated Reprovider block — it FATAL-s Kubo 0.42+ on start), no public/recursive gateway.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IpfsHealth, IpfsPinType } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
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
    form.append("file", blob, absPath);
    // `add` uploads the whole file; its duration scales with file size (a 1.4 GB video far exceeds the
    // 15s control-call cap). Disable the wall-clock timeout (timeoutMs: 0) so large media can finish —
    // the sync limiter bounds concurrency, so this can't stampede the daemon.
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
 * Materialize a file's bytes by CID to `destPath` — the byte side of "fetch" (sync_process.mdx / storage.mdx
 * §9). Streams the HTTP RPC `cat` (a single unixfs file — LFB adds one file per CID) to a temp file, then
 * renames it into place atomically, creating parent dirs. No 15s abort: large media legitimately take a
 * while; the caller bounds concurrency via the sync limiter. A partial download is cleaned up, never left
 * as a truncated final file.
 */
export async function catToFile(cid: string, destPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.lfb-fetch-${process.pid}-${Date.now()}.tmp`;
  try {
    const url = `${apiBase()}/cat?arg=${encodeURIComponent(cid)}`;
    const res = await fetch(url, { method: "POST" });
    if (!res.ok || !res.body) {
      throw new Error(`ipfs cat ${cid} -> ${res.status} ${res.ok ? "empty body" : await res.text()}`);
    }
    // res.body is a WHATWG ReadableStream; adapt it to a Node stream and pipe to disk without buffering.
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(tmp));
    fs.renameSync(tmp, destPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp already gone — ignore */
    }
    log.error("ipfs", `cat ${cid} -> ${destPath} failed: ${(e as Error).message}`);
    throw e;
  }
}

export async function pinAdd(cid: string): Promise<void> {
  try {
    await rpc("pin/add", { args: [cid], query: { recursive: "true" } });
  } catch (e) {
    log.error("ipfs", `pin add failed for ${cid}: ${(e as Error).message}`);
    throw e;
  }
}

export async function pinRm(cid: string): Promise<void> {
  try {
    await rpc("pin/rm", { args: [cid], query: { recursive: "true" } });
  } catch (e) {
    log.warn("ipfs", `pin rm failed for ${cid}: ${(e as Error).message}`);
  }
}

export async function isPinned(cid: string): Promise<boolean> {
  try {
    const res = await rpc("pin/ls", { args: [cid], query: { type: "recursive" } });
    const json = (await res.json()) as { Keys?: Record<string, unknown> };
    return Boolean(json.Keys && json.Keys[cid]);
  } catch (e) {
    log.debug("ipfs", `isPinned check failed for ${cid}: ${(e as Error).message}`);
    return false;
  }
}

// ── Reading the pinset (ipfs.mdx §6 — the scheduleTask's metadata-only read) ─
export interface Pin {
  cid: string;
  type: IpfsPinType;
}

/**
 * The local pinset as ground truth (`ipfs pin ls`). Lists only ROOT pins — recursive + direct —
 * and never the indirect blocks kept under a recursive root (ipfs.mdx §1). Metadata only: it names
 * CIDs and their pin type; it opens no file and moves no bytes.
 */
export async function listPins(): Promise<Pin[]> {
  const out = new Map<string, IpfsPinType>();
  for (const type of ["recursive", "direct"] as const) {
    try {
      const res = await rpc("pin/ls", { query: { type } });
      const json = (await res.json()) as { Keys?: Record<string, { Type?: string }> };
      for (const cid of Object.keys(json.Keys ?? {})) if (!out.has(cid)) out.set(cid, type);
    } catch (e) {
      log.warn("ipfs", `pin ls (${type}) failed: ${(e as Error).message}`);
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
}

const LOOPBACK = /\/ip4\/127\.0\.0\.1\/|\/ip6\/::1\//;

/** Read the live node config for the card; falls back to app-config values when unreachable. */
export async function nodePosture(): Promise<NodePosture> {
  const cfg = getAppConfig();
  try {
    const strat = await readReprovideStrategy();
    const reprovideStrategy =
      strat === "pinned" || strat === "roots" || strat === "all"
        ? (strat as "pinned" | "roots" | "all")
        : cfg.ipfs.reprovide_strategy;
    const gwAddr = await getConfigKey("Addresses.Gateway");
    const gateways = (Array.isArray(gwAddr) ? gwAddr.map(String) : gwAddr ? [String(gwAddr)] : []).filter(Boolean);
    // NO gateway is the safest state (nothing served publicly) → local-only. A configured gateway is
    // local-only iff every address is loopback (knowledge/ipfs.mdx §6/§8).
    const gatewayLocalOnly = gateways.length === 0 || gateways.every((a) => LOOPBACK.test(a));
    // Best-effort: a non-empty GCPeriod means GC is configured to reclaim incidental third-party
    // cache (knowledge/ipfs.mdx §4). RPC can't observe whether the daemon was launched with
    // --enable-gc, so this reads the intent, not the runtime flag.
    const gcPeriod = String((await getConfigKey("Datastore.GCPeriod")) ?? "").trim();
    return { reprovideStrategy, gatewayLocalOnly, gcOn: gcPeriod.length > 0 };
  } catch (e) {
    // Node unreachable — report the configured intent for the card rather than nothing.
    log.debug("ipfs", `nodePosture falling back to config (node unreachable): ${(e as Error).message}`);
    return {
      reprovideStrategy: cfg.ipfs.reprovide_strategy,
      gatewayLocalOnly: !cfg.ipfs.public_gateway,
      gcOn: true,
    };
  }
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

/** True if the running node announces only our own pinned content and runs no public gateway. */
export async function isCompliant(): Promise<boolean> {
  try {
    const strat = await readReprovideStrategy();
    // "pinned" or "roots" are compliant; empty defaults to "all" which is NOT.
    return strat === "pinned" || strat === "roots";
  } catch (e) {
    // Node unreachable -> we can't verify; treat as non-blocking (health handles the red pill).
    log.debug("ipfs", `compliance check skipped (node unreachable): ${(e as Error).message}`);
    return false;
  }
}

/** Bring the node into compliance (unless the user opted out on this machine). */
export async function enforceCompliance(): Promise<void> {
  const cfg = getAppConfig();
  if (cfg.ipfs.public_gateway) {
    log.warn("ipfs", "public_gateway is ON — machine opted out of only-our-content default.");
    return;
  }
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
      if (exposesPublic) {
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
  } catch (e) {
    log.warn("ipfs", `Could not enforce compliance: ${(e as Error).message}`);
  }
}
