// The store must survive a VALUELESS YAML BLOCK.
//
// The outage this file exists for: a one-time migration removed the only child line from under `sync_repo:`
// in all 178 repo unit configs and left the bare parent key behind. YAML reads `sync_repo:` as `null`, and
// `z.object({...}).prefault({})` rejects null ("expected object, received null") — `prefault` fills in for
// UNDEFINED, not for null. So every repo unit config became unreadable at once, and with it every repo-level
// feature: registerRepo, the To-Do recalc, reconcileMirroredRepos, the per-repo pin pass.
//
// `readYaml` now treats exactly that shape as "the key is absent" and re-parses once, so the schema's own
// defaults apply. The repair is narrow on purpose: a field the schema declares `.nullable()` never raises
// this issue, so a legitimate `null` is untouched, and any other validation failure still fails loudly.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readYaml } from "./yaml-store.js";
import { resolveLogDir, resolveStateDir } from "../../config/state-dir.js";

const Schema = z.object({
  pinned: z.boolean().default(false),
  sync_repo: z.object({ enabled: z.boolean().optional() }).prefault({}),
  nested: z.object({ inner: z.object({ n: z.number().default(7) }).prefault({}) }).prefault({}),
  owner_override: z.object({ kind: z.string() }).nullable().default(null),
});

const written: string[] = [];
function tmpYaml(body: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lfb-store-")), "config.yaml");
  fs.writeFileSync(file, body);
  written.push(file);
  return file;
}

afterEach(() => {
  for (const f of written.splice(0)) fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

describe("readYaml — a valueless block must not brick the file", () => {
  it("reads a bare `sync_repo:` as absent and applies the schema default", () => {
    const cfg = readYaml(tmpYaml("pinned: true\nsync_repo:\nowner_override: null\n"), Schema);
    expect(cfg.sync_repo).toEqual({}); // the default — NOT a throw
    expect(cfg.sync_repo.enabled).toBeUndefined(); // absence means "the default", which is ON (§8.4.2)
    expect(cfg.pinned).toBe(true); // every other key survives untouched
  });

  it("repairs a NESTED valueless block too", () => {
    const cfg = readYaml(tmpYaml("nested:\n  inner:\n"), Schema);
    expect(cfg.nested.inner.n).toBe(7);
  });

  it("repairs several valueless blocks in one file", () => {
    const cfg = readYaml(tmpYaml("sync_repo:\nnested:\n"), Schema);
    expect(cfg.sync_repo).toEqual({});
    expect(cfg.nested.inner.n).toBe(7);
  });

  it("leaves a LEGITIMATE null alone — a `.nullable()` field is not a valueless block", () => {
    const cfg = readYaml(tmpYaml("owner_override: null\n"), Schema);
    expect(cfg.owner_override).toBeNull();
  });

  it("still throws loudly on a real schema violation — the repair is not a bulldozer", () => {
    expect(() => readYaml(tmpYaml("pinned: 'not a boolean'\n"), Schema)).toThrow(/Invalid schema/);
  });

  it("still throws when a valueless block is not the whole problem", () => {
    expect(() => readYaml(tmpYaml("sync_repo:\npinned: 12\n"), Schema)).toThrow(/Invalid schema/);
  });
});

// The two negative tests above are SUPPOSED to fail schema validation, and `readYaml` is supposed to log
// that at ERROR before it throws. Both are correct. What was NOT correct: those fixture errors landed in
// the user's PRODUCTION fault trail, ~/T/_large_files_bridge/error.err — four "Schema validation failed:
// /var/folders/.../lfb-store-XXXXXX/config.yaml" entries per run, alongside real faults, in the one file
// the charter designates as the durable record of what actually went wrong on this machine. A fixture that
// forges evidence in the incident log is a defect in its own right.
//
// The cure is environmental, not a lowered log level: vitest.config.ts gives every worker a temp
// LFB_LOG_DIR *and* LFB_STATE_DIR. This guard locks that in — without it the redirect can be dropped from
// the config and nothing fails until someone next reads error.err and finds test noise in it.
describe("test isolation — a spec must never write into the production state root", () => {
  const production = path.join(os.homedir(), "T", "_large_files_bridge");

  it("resolves the log dir and state root away from ~/T/_large_files_bridge", () => {
    expect(resolveLogDir()).not.toBe(production);
    expect(resolveStateDir()).not.toBe(production);
  });

  // Assert on CONTENT, not on file growth: the logger folds repeated near-identical fault lines into
  // `[×N since HH:MM]` (logging.ts collapse), so a second identical ERROR in the same run appends nothing.
  it("sends a failed validation's ERROR line to the redirected error.err, not the production one", () => {
    expect(() => readYaml(tmpYaml("pinned: 'not a boolean'\n"), Schema)).toThrow(/Invalid schema/);
    const redirected = fs.readFileSync(path.join(resolveLogDir(), "error.err"), "utf8");
    expect(redirected).toMatch(/Schema validation failed/); // the fault IS recorded — just not in prod
  });
});
