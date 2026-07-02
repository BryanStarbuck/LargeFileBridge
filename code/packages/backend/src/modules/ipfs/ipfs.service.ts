// Local Kubo/IPFS client over the HTTP RPC (knowledge/ipfs.mdx). Uses fetch, never `curl`.
// Enforces the only-our-content rule: Reprovider.Strategy = pinned, no public/recursive gateway.
import fs from "node:fs";
import type { IpfsHealth } from "@lfb/shared";
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
  opts: { query?: Record<string, string>; args?: string[]; body?: BodyInit } = {},
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

// ── Compliance (knowledge/ipfs.mdx §6) ──────────────────────────────────────
async function getConfigKey(key: string): Promise<unknown> {
  const res = await rpc("config", { args: [key] });
  const json = (await res.json()) as { Value?: unknown };
  return json.Value;
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
      await setConfigKey("Reprovider.Strategy", cfg.ipfs.reprovide_strategy);
      log.info("ipfs", `Set Reprovider.Strategy = ${cfg.ipfs.reprovide_strategy} (only-our-content).`);
    }
  } catch (e) {
    log.warn("ipfs", `Could not enforce compliance: ${(e as Error).message}`);
  }
}
