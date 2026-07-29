// THE 200 KB CEILING (pm/debug.mdx §1.1.1, AC-5b/AC-5c).
//
// The bug this file exists for: `debug.yaml` was specified as "complete, never summarized" with no size
// bound, and on a real machine it produced a 52.8 MB YAML — 1.7 M lines, ~83 k file entries. The artifact
// is COMMITTED AND PUSHED to the shared company repo and is replaced whole every run, so each export added
// another ~52 MB blob to git history, per repo, per member, forever. It was pushed to the company remote
// before anyone noticed, because nothing measured it.
//
// So the budget is a TEST, not an intention. These cases assert the two properties that make the artifact
// safe to commit: it fits, and it does not grow with the machine.
import { describe, it, expect } from "vitest";
import YAML from "yaml";
import { __testing } from "./debug-export.service.js";

const { fitToBudget, summarizeMetrics, metricDigest, SIZE_BUDGET_BYTES } = __testing;
const METRIC_KEYS: readonly string[] = __testing.METRIC_KEYS;

/** A metric entry with the realistic bulk of the real thing (every field the exporter writes). */
function entry(repo: string, i: number): Record<string, unknown> {
  return {
    path: `/Users/bryan/BGit/${repo}/files/videos/some_reasonably_long_file_name_${i}.mp4`,
    repo,
    rel: `files/videos/some_reasonably_long_file_name_${i}.mp4`,
    size_bytes: 734003200,
    cid: `bafkreib4v4qv66scydzxvlhfrc5xrb7xukwnvhqvgiqwjwrxxq3jhsnf${i}`,
    sha256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8${i}`,
    fingerprint: `fp_${i}`,
    perceptual: { algo: "pdq", value: `${i}`.repeat(16) },
    decision: "sync",
    decided_by: "bryan@thestarbucks.com",
    decided_at: "2026-07-29T14:15:00.000Z",
    gitignore: true,
    gitignore_rule: { source: ".gitignore", line: 12, pattern: "*.mp4" },
    transfer: "pinned",
    peers: ["bryan-mac-pro", "bryanstarbuck-macbook-pro"],
    pinned_here: true,
    pinned_foreign: false,
    presence: "present",
    added_by_device: "bryan-mac-pro",
    analysis_only: false,
    never_ipfs: false,
    tasks: { compress: "done", transcribe: "todo", describe: "todo", ocr: "todo" },
    changed_at: "2026-07-29T14:15:00.000Z",
    decision_in_ledger: true,
    artifacts: null,
  };
}

function docWith(perMetric: number, units = 40) {
  const metrics: Record<string, unknown[]> = {};
  for (const k of METRIC_KEYS) {
    metrics[k] = Array.from({ length: perMetric }, (_, i) => entry(`repo_${i % units}`, i));
  }
  return {
    schema_version: 1,
    generated_at: "2026-07-29T14:15:00.000Z",
    generated_by: "debug-export.service.ts",
    app_version: "0.1.0",
    computer: { name: "bryan-mac-pro", home_dir: "/Users/bryan" },
    scope: { kind: "computer", units },
    environment: { ipfs: { reachable: true } },
    errors: [],
    counts: Object.fromEntries(METRIC_KEYS.map((k) => [k, perMetric])),
    units: Array.from({ length: units }, (_, i) => ({
      repo: `repo_${i}`,
      root: `/Users/bryan/BGit/repo_${i}`,
      counts: Object.fromEntries(METRIC_KEYS.map((k) => [k, Math.floor(perMetric / units)])),
    })),
    metrics,
  } as never;
}

const size = (d: unknown) => Buffer.byteLength(YAML.stringify(d), "utf8");

describe("debug export — the 200 KB budget is enforced by construction", () => {
  it("fits an ordinary machine", () => {
    expect(size(fitToBudget(docWith(50)))).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
  });

  // THE ACTUAL BUG: 83k entries produced 52.8 MB.
  it("fits the machine that produced the 52.8 MB file", () => {
    const out = fitToBudget(docWith(4_600)); // ~83k entries across the metric keys
    expect(size(out)).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
  });

  it("DOES NOT SCALE — 100× more files does not produce a bigger file", () => {
    const small = size(fitToBudget(docWith(500)));
    const huge = size(fitToBudget(docWith(50_000)));
    expect(huge).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
    // Not merely "both under the cap" — the big one must not be materially bigger than the small one.
    expect(huge).toBeLessThan(small * 1.5);
  });

  it("keeps every count and every metric key, no matter how hard it had to shrink", () => {
    const out = fitToBudget(docWith(50_000)) as unknown as {
      counts: Record<string, number>;
      metrics: Record<string, { total: number; digest: string | null; sampled: string }>;
    };
    for (const k of METRIC_KEYS) {
      expect(out.counts[k]).toBe(50_000); // the count is never a casualty of the cap
      expect(out.metrics[k].total).toBe(50_000); // …and the list says how big it really was
      expect(out.metrics[k].sampled).toMatch(/^\d+ of 50000$/); // no silent caps
    }
  });

  it("reports what the cap did, so a trimmed export is never mistaken for a full one", () => {
    const out = fitToBudget(docWith(50_000)) as unknown as {
      budget: { limit_bytes: number; sample_per_metric: number; units_dropped: number };
    };
    expect(out.budget.limit_bytes).toBe(SIZE_BUDGET_BYTES);
    expect(out.budget.sample_per_metric).toBeGreaterThanOrEqual(0);
    expect(out.budget).toHaveProperty("units_dropped");
  });
});

describe("debug export — the digest is what survives truncation (AC-5c)", () => {
  it("is identical for the same set and different for a differing one", () => {
    const a = Array.from({ length: 500 }, (_, i) => entry("charlie-kirk", i));
    const same = [...a].reverse(); // order must not matter — two computers enumerate differently
    const different = [...a.slice(0, 499), entry("charlie-kirk", 99999)];
    expect(metricDigest(same as never)).toBe(metricDigest(a as never));
    expect(metricDigest(different as never)).not.toBe(metricDigest(a as never));
  });

  it("joins on repo/rel, NOT the absolute path — the same file on two machines must match", () => {
    const tower = [{ ...entry("charlie-kirk", 1), path: "/Users/bryan/BGit/charlie-kirk/videos/a.mp4" }];
    const laptop = [{ ...entry("charlie-kirk", 1), path: "/Users/other/Code/charlie-kirk/videos/a.mp4" }];
    expect(metricDigest(laptop as never)).toBe(metricDigest(tower as never));
  });

  it("is computed over the FULL set, so truncation cannot change it", () => {
    const all = Array.from({ length: 5_000 }, (_, i) => entry("r", i));
    const full = metricDigest(all as never);
    const summarized = summarizeMetrics({ add_to_ipfs: all } as never, 5) as Record<
      string,
      { digest: string; sample: unknown[] }
    >;
    expect(summarized.add_to_ipfs.digest).toBe(full);
    expect(summarized.add_to_ipfs.sample).toHaveLength(5);
  });
});
