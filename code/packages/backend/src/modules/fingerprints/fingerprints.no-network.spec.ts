// NO NETWORK (perceptual_fingerprint.mdx §6, charter): the fingerprint module and its Go sidecar must never
// open a socket. This is enforced on the SOURCE, so a future edit that imports an HTTP client fails the build.
import { test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.resolve(HERE, "../../../../../sidecars/pdq");

// The router is the ONE file allowed to speak HTTP — it is the server side of the API, not a client.
const TS_FILES = ["pdq-sidecar.ts", "fingerprint.service.ts", "fingerprint.store.ts", "fingerprint.jobs.ts", "fingerprint.csv.ts"];

test("no TypeScript file in the fingerprint engine imports a network client", () => {
  const networkImport =
    /(?:from\s+|require\(\s*)["'](?:node:)?(?:http|https|net|tls|dgram|http2|axios|undici|got|node-fetch|ws|superagent|request)["']/;
  for (const f of TS_FILES) {
    const src = fs.readFileSync(path.join(HERE, f), "utf8");
    expect(networkImport.test(src), `${f} imports a network module`).toBe(false);
    expect(/\bfetch\s*\(/.test(src), `${f} calls fetch()`).toBe(false);
    expect(/new\s+WebSocket\b/.test(src), `${f} opens a WebSocket`).toBe(false);
  }
});

test("the Go sidecar imports no network package and forces ffmpeg to local files", () => {
  for (const f of fs.readdirSync(SIDECAR).filter((n) => n.endsWith(".go"))) {
    const src = fs.readFileSync(path.join(SIDECAR, f), "utf8");
    expect(/"net(\/[a-z]+)?"/.test(src), `${f} imports net/*`).toBe(false);
    expect(/"crypto\/tls"/.test(src), `${f} imports crypto/tls`).toBe(false);
  }
  const video = fs.readFileSync(path.join(SIDECAR, "video.go"), "utf8");
  expect(video).toContain(`"-protocol_whitelist", "file,pipe"`);
  expect(video).toContain(`"file:"+path`);
});
