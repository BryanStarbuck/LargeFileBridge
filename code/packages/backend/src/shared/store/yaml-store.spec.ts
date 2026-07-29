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
import { readYaml, writeYamlIfChanged, canonicalize } from "./yaml-store.js";
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

// A TIMESTAMP IS NOT A CHANGE (the 2026-07-29 backbone-churn bug).
//
// `writeYaml` stamps `updated_at: now` unconditionally, so re-writing an identical document still produced
// a byte-different file. `writeSelfDevice` runs on every device pass (10 min), every pin pass (15 min) and
// every artifact sync, for every storage — so each cycle committed a diff that was exactly one line:
//
//     -updated_at: 2026-07-29T14:15:25.865Z
//     +updated_at: 2026-07-29T14:15:30.942Z
//
// With the same remote cloned twice on one machine, both clones wrote the same `devices/<self>.yaml` every
// cycle, so every cycle ended in a merge conflict, a non-fast-forward push, three retries and "giving up
// this cycle". `writeYamlIfChanged` is what stops the churn at the source.
describe("writeYamlIfChanged — no write when only the timestamp would move", () => {
  it("skips an identical document and leaves updated_at untouched", () => {
    const file = tmpYaml("");
    expect(writeYamlIfChanged(file, { device: { id: "abc", name: "tower" } })).toBe(true);
    const first = fs.readFileSync(file, "utf8");
    const stamp = first.match(/updated_at: (.+)/)?.[1];
    expect(stamp).toBeTruthy();

    // Same content again → no write at all, so the stamp (and the bytes git sees) do not move.
    expect(writeYamlIfChanged(file, { device: { id: "abc", name: "tower" } })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("writes when any real field changes", () => {
    const file = tmpYaml("");
    writeYamlIfChanged(file, { device: { id: "abc", name: "tower" } });
    const before = fs.readFileSync(file, "utf8");
    expect(writeYamlIfChanged(file, { device: { id: "abc", name: "laptop" } })).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    expect(after).not.toBe(before);
    expect(after).toMatch(/name: laptop/);
  });

  it("ignores a differing updated_at in the value it is handed", () => {
    const file = tmpYaml("");
    writeYamlIfChanged(file, { device: { id: "abc" }, updated_at: "2020-01-01T00:00:00.000Z" });
    const first = fs.readFileSync(file, "utf8");
    // The caller re-reads the doc (carrying the stamp it just wrote) and hands it back — still a no-op.
    expect(writeYamlIfChanged(file, { device: { id: "abc" }, updated_at: "2026-07-29T00:00:00.000Z" })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("writes when the file does not exist yet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-store-"));
    const file = path.join(dir, "fresh.yaml");
    expect(writeYamlIfChanged(file, { a: 1 })).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── THE CANONICAL COMPARISON (git_backbone.mdx §6.6) ──────────────────────────────────────────────────
//
// The first cut of `writeYamlIfChanged` compared `YAML.stringify(rawDiskDoc)` with
// `YAML.stringify(schemaParsedValue)`. Those two are never textually equal even when they mean the same
// thing — a zod-parsed object carries the SCHEMA's key order and the schema's injected defaults, while the
// disk file carries whatever order it was last written in and none of the defaults it predates. So the
// guard never fired and the churn it was written to stop carried on: 2,437 commits in 7 days on the live
// personal tracking repo, 2,322 of them a `devices/*.yaml` touch whose diff was one `updated_at` line.
describe("writeYamlIfChanged — the comparison is canonical, not textual", () => {
  it("treats a pure key REORDER as no change", () => {
    const file = tmpYaml("");
    writeYamlIfChanged(file, { device: { id: "abc", name: "tower", owner: null } });
    const first = fs.readFileSync(file, "utf8");
    // Same document, schema order — this is exactly what a zod parse hands back.
    expect(writeYamlIfChanged(file, { device: { owner: null, name: "tower", id: "abc" } })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("treats a key set to undefined the same as an absent key", () => {
    const file = tmpYaml("");
    writeYamlIfChanged(file, { device: { id: "abc" } });
    const first = fs.readFileSync(file, "utf8");
    // YAML omits an undefined value on write, so it must also compare equal to absent on read — otherwise
    // the volatile-hardware overlay in writeSelfDevice forces a write on every single pass.
    expect(writeYamlIfChanged(file, { device: { id: "abc", screen_inches: undefined } })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("converges: a document that gains a new field writes ONCE, then goes quiet forever", () => {
    const file = tmpYaml("");
    writeYamlIfChanged(file, { device: { id: "abc" } });
    // An older file meets a build that publishes one more field: a genuine, one-time repair...
    expect(writeYamlIfChanged(file, { device: { id: "abc", home_user: "bryan" } })).toBe(true);
    // ...and then never again. A guard that cannot converge is the churn it was meant to remove.
    for (let i = 0; i < 5; i++) {
      expect(writeYamlIfChanged(file, { device: { id: "abc", home_user: "bryan" } })).toBe(false);
    }
  });
});

describe("writeYamlIfChanged — declared volatile paths get no vote", () => {
  const IPS = ["device.hardware.primary_ip", "device.hardware.ip_addresses"];

  it("does not write when only the network addresses moved", () => {
    const file = tmpYaml("");
    const doc = (ips: string[]) => ({
      device: { hardware: { chip: "M2 Ultra", primary_ip: ips[0], ip_addresses: ips } },
    });
    writeYamlIfChanged(file, doc(["192.168.50.167", "fe80::1"]), { volatile: IPS });
    const first = fs.readFileSync(file, "utf8");
    // A laptop grows and drops link-local addresses on its own; no user did anything.
    expect(writeYamlIfChanged(file, doc(["192.168.50.9", "fe80::9", "fe80::2"]), { volatile: IPS })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("still writes when a NON-volatile field moves alongside the volatile ones", () => {
    const file = tmpYaml("");
    writeYamlIfChanged(file, { device: { hardware: { chip: "M2 Ultra", ip_addresses: ["fe80::1"] } } }, { volatile: IPS });
    // The chip changed — that is real news, and the fresh addresses ride along with it.
    expect(
      writeYamlIfChanged(file, { device: { hardware: { chip: "M4 Max", ip_addresses: ["fe80::9"] } } }, { volatile: IPS }),
    ).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toMatch(/fe80::9/);
  });

  it("keeps ARRAY ORDER meaningful — a reordered list is a real change", () => {
    // Key order is noise; list order can be meaning (a priority list, a ranked address list), so
    // canonicalize sorts keys and never sorts arrays.
    expect(canonicalize({ k: ["a", "b"] }, [])).not.toBe(canonicalize({ k: ["b", "a"] }, []));
  });
});
