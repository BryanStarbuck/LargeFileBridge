// Per-user prefs (compression_visibility.mdx §1.1) — "Show compression features" is OFF by default, is per
// user, and a patch changes only what it sends.
//
// Runner: vitest (`pnpm test` in this package). Isolated state root; the env var is left pointing at the
// temp dir (never deleted) so a later spec file can't fall through to the live ~/T/_large_files_bridge.
import { test, beforeEach, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-user-prefs-test-"));
process.env.LFB_STATE_DIR = TMP;
process.env.LFB_LOG_DIR = TMP;

const { loadUserPrefs, saveUserPrefs } = await import("./user-prefs.service.js");
const { getUserConfig } = await import("./user-config.service.js");

beforeEach(() => {
  fs.rmSync(path.join(TMP, "users"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("a user with no config reads compression OFF — and reading never writes", () => {
  assert.deepEqual(loadUserPrefs("new@example.com"), { features: { compression: false } });
  assert.equal(fs.existsSync(path.join(TMP, "users")), false);
});

test("turning it on persists per user, and leaves the rest of the config alone", async () => {
  await saveUserPrefs("a@example.com", { features: { compression: true } });
  assert.equal(loadUserPrefs("a@example.com").features.compression, true);
  assert.equal(loadUserPrefs("b@example.com").features.compression, false); // per user, not per computer
  assert.equal(getUserConfig("a@example.com").ui.theme, "system"); // other blocks keep their defaults
  await saveUserPrefs("a@example.com", { features: {} }); // an empty patch changes nothing
  assert.equal(loadUserPrefs("a@example.com").features.compression, true);
  await saveUserPrefs("a@example.com", { features: { compression: false } });
  assert.equal(loadUserPrefs("a@example.com").features.compression, false);
});
