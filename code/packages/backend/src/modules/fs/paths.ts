// Path resolution shared by the File System services (fs.service.ts) and the streaming filesystem
// index (fsindex/fsindex.service.ts). Extracted here so BOTH can depend on it without fs.service and
// fsindex importing each other (performance.mdx Part III — no circular import).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function homeDir(): string {
  return os.homedir();
}

/** Resolve + validate the requested path to an existing absolute directory. */
export function resolveDir(input: string | undefined): string {
  const raw = (input && input.trim()) || homeDir();
  const expanded = raw.replace(/^~(?=\/|$)/, os.homedir());
  const abs = path.resolve(expanded);
  if (abs.includes("\0")) throw new Error("invalid path");
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error("directory not found");
  }
  if (!st.isDirectory()) throw new Error("not a directory");
  return abs;
}
