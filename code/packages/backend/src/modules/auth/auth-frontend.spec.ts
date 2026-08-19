// SIGN-IN MUST NOT DEPEND ON WHAT THE CREDENTIALS FILE HELD AT BOOT.
//
// The bug this guards (2026-08-19). The app booted, found no `google` block in
// ~/.credentials/large_files_bridge.json, mounted a PASSTHROUGH at /api/v1 and logged "No Google
// creds — auth Frontend API not mounted". Two minutes later the creds were pasted in — which is the
// documented setup flow: the sign-in screen tells the user to create exactly that file, and
// `ensureApiSecret()` creates it AT BOOT with only the `api` block, so "file exists, google block
// arrives later" is the normal first-run ordering, not an edge case.
//
// Nothing re-checked. The mount decision was made once, at boot, forever. So every sign-in attempt
// walked through the passthrough, matched no route, and Express answered:
//
//   Cannot GET /api/v1/sign_in/sso
//
// while /api/health/auth-config — which re-reads the file live — reported `oauthConfigured: true`.
// The UI said configured, the router 404'd, and only a manual restart reconciled the two.
//
// These tests drive the REAL middleware over a real socket, mutating the creds file underneath a
// running server exactly as a user editing that file does.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAuthFrontend } from "./auth-frontend.js";
import { _resetCredsCacheForTests } from "../../config/credentials-file.js";

const SSO = "/api/v1/sign_in/sso";

let credsFile: string;
let server: http.Server;
let base: string;

/** The `api`-only shape `ensureApiSecret()` writes at boot, before any Google creds exist. */
function writeCredsWithoutGoogle(): void {
  fs.writeFileSync(
    credsFile,
    JSON.stringify({ large_files_bridge: { api: { secret_key: "0".repeat(64) } } }, null, 2),
  );
  _resetCredsCacheForTests();
}

/** What the user pastes in after the sign-in screen tells them to. Values are fake. */
function writeCredsWithGoogle(clientId = "test-client-id.apps.googleusercontent.com"): void {
  fs.writeFileSync(
    credsFile,
    JSON.stringify(
      {
        large_files_bridge: {
          google: { clientId, clientSecret: "test-client-secret" },
          api: { secret_key: "0".repeat(64) },
        },
      },
      null,
      2,
    ),
  );
  _resetCredsCacheForTests();
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfb-auth-fe-"));
  credsFile = path.join(dir, "large_files_bridge.json");
  process.env.LFB_CREDENTIALS_FILE = credsFile;
  delete process.env.GOOGLE_CLIENT_ID; // env creds would win over the file and defeat the test
  delete process.env.GOOGLE_CLIENT_SECRET;

  // Boot the server the way main.ts does — with NO Google creds on disk, the state that made the
  // mount permanent. buildAuthFrontend() is called exactly once, as in production.
  writeCredsWithoutGoogle();
  const app = express();
  app.use("/api/v1", buildAuthFrontend());

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  writeCredsWithoutGoogle(); // every test states its own starting point
});

// `redirect: manual` — a mounted router answers /sign_in/sso with a 302 to Google, and following it
// would put a real network call in the test suite.
const getSso = () => fetch(`${base}${SSO}`, { redirect: "manual" });

describe("auth Frontend API mount tracks the credentials file", () => {
  it("404s while there are genuinely no creds (passthrough is correct here)", async () => {
    expect((await getSso()).status).toBe(404);
  });

  it("serves sign-in once creds appear AFTER boot — no restart (the bug)", async () => {
    expect((await getSso()).status).toBe(404); // the boot-time state

    writeCredsWithGoogle(); // the user pastes the google block into the file

    const res = await getSso();
    // The precise status is the SDK's business; what this asserts is that the request was ANSWERED
    // by the auth router instead of falling through to "Cannot GET /api/v1/sign_in/sso".
    expect(res.status).not.toBe(404);
    expect(await res.text()).not.toContain("Cannot GET");
  });

  it("picks up a CORRECTED client id without a restart", async () => {
    writeCredsWithGoogle("wrong-id.apps.googleusercontent.com");
    expect((await getSso()).status).not.toBe(404);

    writeCredsWithGoogle("fixed-id.apps.googleusercontent.com");
    const location = (await getSso()).headers.get("location") ?? "";
    // The rebuilt middleware must be carrying the NEW client id to Google, not the old one.
    expect(location).toContain("fixed-id.apps.googleusercontent.com");
    expect(location).not.toContain("wrong-id.apps.googleusercontent.com");
  });

  it("falls back to passthrough when creds are removed", async () => {
    writeCredsWithGoogle();
    expect((await getSso()).status).not.toBe(404);

    writeCredsWithoutGoogle();
    expect((await getSso()).status).toBe(404);
  });

  it("keeps serving when the creds file is unreadable garbage", async () => {
    writeCredsWithGoogle();
    expect((await getSso()).status).not.toBe(404);

    fs.writeFileSync(credsFile, "{ this is not json");
    _resetCredsCacheForTests();
    // A broken edit must not 500 every /api/v1 request — unparsable reads as "no creds", so the
    // request falls through to the host app the same way an absent file does.
    const res = await getSso();
    expect(res.status).toBeLessThan(500);
  });
});
