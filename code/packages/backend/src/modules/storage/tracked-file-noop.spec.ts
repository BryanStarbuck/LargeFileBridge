// THE HANG, reduced to one branch: `copyTrackedFile` merged two byte-identical documents.
//
// The mirror is a RECONCILIATION to current state, not a queue of changes — so every backbone pass
// re-mirrors every sidecar of every repo, changed or not. Measured on the live machine: 20,059 of 20,062
// sidecars (99.98%) were byte-identical between Local Storage and the mirror on a given pass, and each one
// still paid two `readFileSync`s, two full YAML parses and a `YAML.stringify` to arrive back at the bytes
// already on disk. A CPU profile of the running backend attributed 7.9 s of 17 s of non-idle time to
// `readYamlDoc` alone. From the outside that is `[loop-watch] EVENT LOOP BLOCKED … up to 13858ms` and
// `[run-worker] no acknowledgement from the app within 15s over 3 attempts`.
//
// The identical-bytes check already existed — it just sat BELOW the shape dispatch, guarding only the
// plain copy, which was the one path that was already cheap. These tests pin it above the dispatch, and
// pin that moving it did not cost the merge any of its real work.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { copyTrackedFile } from "./tracked-file-merge.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-noop-"));
  dirs.push(d);
  return d;
}

const sidecar = (events: { at: string; kind: string; on_device: string }[]): string =>
  YAML.stringify({ file: { size: 1024, first_seen: events[0]?.at, events } }, { sortMapEntries: true });

const EV_A = { at: "2026-08-01T10:00:00Z", kind: "scan", on_device: "tower" };
const EV_B = { at: "2026-08-02T11:00:00Z", kind: "ipfs_pin", on_device: "laptop" };

describe("copyTrackedFile — identical bytes cost nothing", () => {
  it("does NOT parse YAML when a sidecar is byte-identical to its destination", () => {
    const d = tmp();
    const src = path.join(d, "src.yaml");
    const dst = path.join(d, "dst.yaml");
    const bytes = sidecar([EV_A, EV_B]);
    fs.writeFileSync(src, bytes);
    fs.writeFileSync(dst, bytes);

    // The assertion that matters: the expensive work is not merely wasted, it does not happen.
    const parse = vi.spyOn(YAML, "parse");
    const stringify = vi.spyOn(YAML, "stringify");

    expect(copyTrackedFile(src, dst, "files/videos/clip.mp4.yaml")).toBe(false);
    expect(parse).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    expect(fs.readFileSync(dst, "utf8")).toBe(bytes); // and the bytes are untouched
  });

  it("does NOT read a history log that is byte-identical either", () => {
    const d = tmp();
    const src = path.join(d, "src.txt");
    const dst = path.join(d, "dst.txt");
    fs.writeFileSync(src, "2026-08-01 scan\n2026-08-02 pin\n");
    fs.writeFileSync(dst, "2026-08-01 scan\n2026-08-02 pin\n");
    expect(copyTrackedFile(src, dst, "history/tower.txt")).toBe(false);
  });

  it("STILL MERGES when the two sides genuinely differ — the fast path must not eat real work", () => {
    const d = tmp();
    const src = path.join(d, "src.yaml");
    const dst = path.join(d, "dst.yaml");
    fs.writeFileSync(src, sidecar([EV_B])); // this computer saw the pin
    fs.writeFileSync(dst, sidecar([EV_A])); // the mirror carries a peer's scan

    expect(copyTrackedFile(src, dst, "files/videos/clip.mp4.yaml")).toBe(true);
    const merged = YAML.parse(fs.readFileSync(dst, "utf8")) as {
      file: { events: { kind: string }[] };
    };
    // Union, not overwrite — losing either half is the defect tracked-file-merge.ts exists to prevent.
    expect(merged.file.events.map((e) => e.kind).sort()).toEqual(["ipfs_pin", "scan"]);
  });

  it("still copies a brand-new sidecar the mirror has never seen", () => {
    const d = tmp();
    const src = path.join(d, "src.yaml");
    const dst = path.join(d, "dst.yaml");
    fs.writeFileSync(src, sidecar([EV_A]));
    expect(copyTrackedFile(src, dst, "files/videos/new.mp4.yaml")).toBe(true);
    expect(fs.readFileSync(dst, "utf8")).toBe(sidecar([EV_A]));
  });
});
