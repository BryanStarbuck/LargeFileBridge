// Semantics + the perf property of the non-throwing probes (shared/fs-probe.ts).
//
// The perf test is the point of this file. The whole reason fs-probe exists is that
// `try { statSync(p) } catch {}` pays a full V8 Error construction + stack capture on every MISS, and a
// profile attributed ~64% of the backend's CPU to exactly that. A future refactor that quietly reverts a
// helper to the throwing idiom would keep every semantic test green — so we assert the missing-path probe
// is materially faster than the throwing one, which only holds while `throwIfNoEntry: false` is in play.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  statOrNull,
  lstatOrNull,
  isFileAt,
  isDirAt,
  existsAt,
  sizeOrNull,
  sizeOrZero,
  mtimeMsOrNull,
} from "./fs-probe.js";

let dir = "";
let file = "";
let missing = "";
let link = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-fs-probe-"));
  file = path.join(dir, "hello.txt");
  fs.writeFileSync(file, "hello", "utf8");
  missing = path.join(dir, "nope", "not-here.transcription"); // parent doesn't exist either → ENOENT
  link = path.join(dir, "dangling.link");
  fs.symlinkSync(path.join(dir, "gone"), link);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("fs-probe semantics", () => {
  it("statOrNull returns stats for a real file and null for a missing one", () => {
    expect(statOrNull(file)?.size).toBe(5);
    expect(statOrNull(missing)).toBeNull();
  });

  it("isFileAt / isDirAt discriminate, and both are false for a missing path", () => {
    expect(isFileAt(file)).toBe(true);
    expect(isFileAt(dir)).toBe(false);
    expect(isDirAt(dir)).toBe(true);
    expect(isDirAt(file)).toBe(false);
    expect(isFileAt(missing)).toBe(false);
    expect(isDirAt(missing)).toBe(false);
  });

  it("existsAt is true for file and dir, false for missing", () => {
    expect(existsAt(file)).toBe(true);
    expect(existsAt(dir)).toBe(true);
    expect(existsAt(missing)).toBe(false);
  });

  it("size + mtime helpers degrade to null / 0 instead of throwing", () => {
    expect(sizeOrNull(file)).toBe(5);
    expect(sizeOrNull(missing)).toBeNull();
    expect(sizeOrZero(missing)).toBe(0);
    expect(typeof mtimeMsOrNull(file)).toBe("number");
    expect(mtimeMsOrNull(missing)).toBeNull();
  });

  it("a DANGLING SYMLINK reads as missing via stat, but is seen by lstat", () => {
    // statSync follows the link → the target is gone → null. This is the behaviour cloud-roots.ts
    // depends on to skip a half-removed mount.
    expect(statOrNull(link)).toBeNull();
    expect(isDirAt(link)).toBe(false);
    // lstat stats the LINK ITSELF, which very much exists.
    expect(lstatOrNull(link)?.isSymbolicLink()).toBe(true);
  });

  it("never throws, whatever it is handed", () => {
    for (const p of ["", "/", "\0bad", missing, link, "/root/definitely/not/allowed"]) {
      expect(() => statOrNull(p)).not.toThrow();
      expect(() => isFileAt(p)).not.toThrow();
      expect(() => existsAt(p)).not.toThrow();
    }
  });
});

describe("fs-probe performance (the reason this module exists)", () => {
  it("probing a MISSING path is much cheaper than the throwing statSync idiom", () => {
    const N = 20_000;
    // Warm both paths so we compare steady-state, not JIT warmup.
    for (let i = 0; i < 500; i++) {
      try {
        fs.statSync(missing).isFile();
      } catch {
        /* the idiom under comparison */
      }
      isFileAt(missing);
    }

    let t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      try {
        fs.statSync(missing).isFile();
      } catch {
        /* throw-per-miss: builds a V8 Error and captures a stack every time */
      }
    }
    const throwing = Number(process.hrtime.bigint() - t);

    t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) isFileAt(missing);
    const nonThrowing = Number(process.hrtime.bigint() - t);

    // Measured 6–9× on an M-series Mac. Assert a deliberately loose 2× so this is a REGRESSION guard
    // (someone reverted to the throwing idiom → ~1×), not a flaky benchmark on a loaded CI box.
    expect(nonThrowing).toBeLessThan(throwing / 2);
  });
});
