// Local Kubo/IPFS client over the HTTP RPC (knowledge/ipfs.mdx). Uses fetch, never `curl`.
// Enforces the only-our-content rule: Reprovider.Strategy = pinned, no public/recursive gateway.
import fs from "node:fs";
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

async function rpc(
  cmd: string,
  opts: { query?: Record<string, string>; args?: string[]; body?: FormData } = {},
) {
  const params = new URLSearchParams(opts.query);
  for (const a of opts.args ?? []) params.append("arg", a); // repeated ?arg=…&arg=…
  const qs = params.toString() ? `?${params.toString()}` : "";
  const url = `${apiBase()}/${cmd}${qs}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { method: "POST", body: opts.body, signal: ctrl.signal });
    if (!res.ok) throw new Error(`ipfs ${cmd} -> ${res.status} ${await res.text()}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

export async function health(): Promise<IpfsHealth> {
  try {
    await rpc("id");
    return "ok";
  } catch {
    return "unreachable";
  }
}

export async function peerId(): Promise<string | null> {
  try {
    const res = await rpc("id");
    const json = (await res.json()) as { ID?: string };
    return json.ID ?? null;
  } catch {
    return null;
  }
}

/** Add a file and pin it recursively; returns its root CID (ipfs.mdx §3). */
export async function addFile(absPath: string): Promise<string> {
  // fs.openAsBlob streams the file rather than buffering it whole into memory.
  const blob = await (fs as unknown as { openAsBlob(p: string): Promise<Blob> }).openAsBlob(absPath);
  const form = new FormData();
  form.append("file", blob, absPath);
  const res = await rpc("add", { query: { pin: "true", "cid-version": "1" }, body: form });
  const text = await res.text();
  // add streams NDJSON; the final line has the root entry.
  const lines = text.trim().split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]) as { Hash?: string };
  if (!last.Hash) throw new Error("ipfs add returned no CID");
  return last.Hash;
}

export async function pinAdd(cid: string): Promise<void> {
  await rpc("pin/add", { args: [cid], query: { recursive: "true" } });
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
  } catch {
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
  } catch {
    return null;
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
    const strat = String((await getConfigKey("Reprovider.Strategy")) ?? "").toLowerCase();
    const reprovideStrategy =
      strat === "pinned" || strat === "roots" || strat === "all"
        ? (strat as "pinned" | "roots" | "all")
        : cfg.ipfs.reprovide_strategy;
    const gwAddr = await getConfigKey("Addresses.Gateway");
    const gateways = Array.isArray(gwAddr) ? (gwAddr as string[]) : gwAddr ? [String(gwAddr)] : [];
    const gatewayLocalOnly = gateways.length > 0 && gateways.every((a) => LOOPBACK.test(a));
    // Best-effort: a non-empty GCPeriod means GC is configured to reclaim incidental third-party
    // cache (knowledge/ipfs.mdx §4). RPC can't observe whether the daemon was launched with
    // --enable-gc, so this reads the intent, not the runtime flag.
    const gcPeriod = String((await getConfigKey("Datastore.GCPeriod")) ?? "").trim();
    return { reprovideStrategy, gatewayLocalOnly, gcOn: gcPeriod.length > 0 };
  } catch {
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

/** True if the running node announces only our own pinned content and runs no public gateway. */
export async function isCompliant(): Promise<boolean> {
  try {
    const strat = String((await getConfigKey("Reprovider.Strategy")) ?? "").toLowerCase();
    // "pinned" or "roots" are compliant; empty defaults to "all" which is NOT.
    return strat === "pinned" || strat === "roots";
  } catch {
    // Node unreachable -> we can't verify; treat as non-blocking (health handles the red pill).
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
    const strat = String((await getConfigKey("Reprovider.Strategy")) ?? "").toLowerCase();
    if (strat !== "pinned" && strat !== "roots") {
      try {
        await setConfigKey("Reprovider.Strategy", cfg.ipfs.reprovide_strategy);
        log.info("ipfs", `Set Reprovider.Strategy = ${cfg.ipfs.reprovide_strategy} (only-our-content).`);
      } catch (e) {
        // Some Kubo builds don't expose Reprovider.Strategy at all; the SET then 500s "not found".
        // That's a benign capability gap, not a fault — log it once at info so it stays out of error.err.
        if (/not found/i.test((e as Error).message)) {
          log.info("ipfs", `Reprovider.Strategy not settable on this Kubo build — skipping enforcement.`);
        } else {
          throw e;
        }
      }
    }
  } catch (e) {
    log.warn("ipfs", `Could not enforce compliance: ${(e as Error).message}`);
  }
}
