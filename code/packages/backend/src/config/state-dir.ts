// Resolve the single state root (storage.mdx §1). No DB — everything persists here.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function resolveStateDir(): string {
  const dir =
    process.env.LFB_STATE_DIR ||
    safeJoin(os.homedir(), "T", "_large_files_bridge") ||
    "/tmp/_large_files_bridge";
  ensureDir(dir);
  return dir;
}

export function resolveLogDir(): string {
  const dir = process.env.LFB_LOG_DIR || resolveStateDir();
  ensureDir(dir);
  return dir;
}

function safeJoin(...parts: string[]): string | null {
  try {
    return path.join(...parts);
  } catch {
    return null;
  }
}

export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort: never crash because a dir couldn't be made (storage.mdx §1)
  }
}
