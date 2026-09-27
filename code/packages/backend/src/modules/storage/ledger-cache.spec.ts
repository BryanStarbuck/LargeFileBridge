// The parsed-ledger cache (performance.mdx P-59): a re-read of an untouched ledger costs no parse, and ANY
// change to the file — by any writer — is seen on the next read.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { readLedger, resetLedgerCache } from "./decisions.service.js";
import { resolveTrackingRoot } from "./tracking-root.service.js";

let tmp: string;
let repoRoot: string;
const ledgerFile = (): string => path.join(resolveTrackingRoot(repoRoot), "decisions.yaml");
const writeEvents = (...paths: string[]): void => {
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  fs.writeFileSync(
    ledgerFile(),
    YAML.stringify({
      schema_version: 1,
      events: paths.map((p) => ({ sid: "s", path: p, decided_at: "2026-09-27T10:00:00.000Z" })),
    }),
  );
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-ledger-cache-"));
  process.env.LFB_STATE_DIR = path.join(tmp, "state");
  repoRoot = path.join(tmp, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  resetLedgerCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LFB_STATE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the parsed-ledger cache", () => {
  it("does not re-parse an untouched ledger", () => {
    writeEvents("a.mp4");
    expect(readLedger(repoRoot).map((e) => e.path)).toEqual(["a.mp4"]);
    const parse = vi.spyOn(YAML, "parse");
    for (let i = 0; i < 5; i++) expect(readLedger(repoRoot).map((e) => e.path)).toEqual(["a.mp4"]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("sees a change made by another writer", () => {
    writeEvents("a.mp4");
    readLedger(repoRoot);
    writeEvents("a.mp4", "b.mp4"); // e.g. the reconcile leg, or a git merge
    expect(readLedger(repoRoot).map((e) => e.path)).toEqual(["a.mp4", "b.mp4"]);
  });

  it("hands each caller its own list, so appending to one cannot change the cache", () => {
    writeEvents("a.mp4");
    const first = readLedger(repoRoot);
    first.push({ ...first[0]!, path: "mutated.mp4" });
    expect(readLedger(repoRoot).map((e) => e.path)).toEqual(["a.mp4"]);
  });
});
