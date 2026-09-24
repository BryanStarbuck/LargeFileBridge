import { test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secretsMatch, loopbackHost } from "./identify.js";
import { ensureApiSecret, loadApiSecret, rotateApiSecret, apiSecretStatus } from "../../config/credentials-file.js";

test("secretsMatch is exact and length-independent", () => {
  const k = "a".repeat(64);
  expect(secretsMatch(k, k)).toBe(true);
  expect(secretsMatch(k, "a".repeat(63))).toBe(false);
  expect(secretsMatch("", k)).toBe(false);
  expect(secretsMatch(k + "x", k)).toBe(false);
});

let dir = "";
let prev: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-creds-spec-"));
  prev = process.env.LFB_CREDENTIALS_FILE;
  process.env.LFB_CREDENTIALS_FILE = path.join(dir, "large_files_bridge.json");
});
afterEach(() => {
  // Restore, never delete-and-leave-unset (the state-root leak lesson): put back exactly what was there.
  if (prev === undefined) delete process.env.LFB_CREDENTIALS_FILE;
  else process.env.LFB_CREDENTIALS_FILE = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ensureApiSecret creates a 0600 key and keeps the other blocks in the file", () => {
  const p = process.env.LFB_CREDENTIALS_FILE!;
  fs.writeFileSync(p, JSON.stringify({ large_files_bridge: { google: { clientId: "keep-me" } } }), { mode: 0o644 });
  const key = ensureApiSecret();
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  expect(doc.large_files_bridge.google.clientId).toBe("keep-me");
  expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  expect(apiSecretStatus().fingerprint).toMatch(/^sha256:[0-9a-f]{8}$/);
  const rotated = rotateApiSecret();
  expect(rotated).not.toBe(key);
  expect(loadApiSecret()).toBe(rotated);
});

test("a credentials file that will not parse is NEVER overwritten", () => {
  const p = process.env.LFB_CREDENTIALS_FILE!;
  const broken = '{ "large_files_bridge": { "google": { "clientId": "precious", } ';
  fs.writeFileSync(p, broken, { mode: 0o600 });
  expect(() => ensureApiSecret()).toThrow();
  expect(fs.readFileSync(p, "utf8")).toBe(broken);
});

test("the machine key is only honored for a loopback Host header (DNS rebinding)", () => {
  expect(loopbackHost("127.0.0.1:8787")).toBe(true);
  expect(loopbackHost("localhost:8787")).toBe(true);
  expect(loopbackHost("[::1]:8787")).toBe(true);
  expect(loopbackHost("evil.example:8787")).toBe(false);
  expect(loopbackHost("127.0.0.1.evil.example")).toBe(false);
  expect(loopbackHost(undefined)).toBe(false);
});
