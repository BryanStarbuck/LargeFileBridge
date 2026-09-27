// The watermark counters scan lines instead of parsing multi-megabyte YAML (performance.mdx P-62). They must
// agree with a real parse on every shape the serializers write — and on the real charlie-kirk manifest.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { countersForTest } from "./doc-render.service.js";
import { serializeManifest } from "./manifest-merge.js";
import { serializeLedger } from "./ledger-merge.js";

const tmpFile = (text: string): string => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lfb-counts-")), "doc.yaml");
  fs.writeFileSync(f, text);
  return f;
};
const claimsByParse = (text: string): number =>
  ((YAML.parse(text) as { files: { pinned_by?: string[] }[] }).files ?? []).reduce((n, f) => n + (f.pinned_by?.length ?? 0), 0);

describe("arrival counters", () => {
  it("count manifest claims exactly as a parse does — empty lists, removed entries, many claims", () => {
    const text = serializeManifest({
      schema_version: 1,
      unit: "repo",
      files: [
        { path: "a.mp4", cid: "bafyA", size: 1, sha256: null, pinned_by: ["laptop", "tower"] },
        { path: "b.mp4", cid: null, size: 2, sha256: null, pinned_by: [] },
        { path: "c.mp4", cid: "bafyC", size: 3, sha256: "x", pinned_by: ["studio"], state: "removed" },
        { path: "d.mp4", cid: "bafyD", size: 4, sha256: null, pinned_by: ["a", "b", "c", "d"] },
      ],
    });
    expect(countersForTest.countArrivingClaims(tmpFile(text))).toBe(claimsByParse(text));
  });

  it("count ledger events exactly as a parse does", () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      sid: "s", path: `f${i}.mp4`, fingerprint: null, asked: true, ipfs: i % 2 === 0, gitignore: false,
      decided_by: "me", decided_at: `2026-09-27T10:${String(i).padStart(2, "0")}:00.000Z`,
    }));
    expect(countersForTest.countArrivingEvents(tmpFile(serializeLedger(events)))).toBe(50);
  });

  const real = path.join(os.homedir(), "BGit/act3/act3_large_files_bridge/repos/charlie-kirk-83e62afc2c80/manifest.yaml");
  it.skipIf(!fs.existsSync(real))("agree with a parse on the real charlie-kirk manifest", () => {
    expect(countersForTest.countArrivingClaims(real)).toBe(claimsByParse(fs.readFileSync(real, "utf8")));
  });
});
