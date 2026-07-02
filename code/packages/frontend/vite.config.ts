import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { resolveWebPort, DEFAULT_WEB_PORT } from "./scripts/web-port.mjs";

// Grant read access up to the LargeFileBridge repo root so we can import pm/left_bar.yaml?raw
// (left_bar.mdx §AC4 — the frontend renders the nav straight from the yaml, no code copy).
const repoRoot = path.resolve(__dirname, "../../..");

export default defineConfig(async () => {
  // The web app that serves pages ALWAYS defaults to :2222 (code_plan.mdx §2). Before Vite binds we
  // resolve the real port under the collision policy: free → take it; held by our own stale instance
  // → kill it and reclaim :2222; held by a foreign process → increment and report the moved port.
  const { port, action, from } = await resolveWebPort();
  if (action === "took-over") {
    console.log(`[LFB] :${port} was a stale LargeFileBridge instance — replaced it with this one.`);
  } else if (action === "moved") {
    console.log(
      `[LFB] :${from} is in use by another (non-LFB) process. Web app moved to :${port}. ` +
        `Open http://localhost:${port}/`,
    );
  } else if (port !== DEFAULT_WEB_PORT) {
    console.log(`[LFB] Web app on :${port}.`);
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port,
      strictPort: true, // the port is already resolved above — never let Vite silently pick another
      fs: { allow: [repoRoot] },
      proxy: {
        "/api": { target: "http://localhost:8787", changeOrigin: true },
      },
    },
    resolve: {
      alias: { "@": path.resolve(__dirname, "src") },
    },
  };
});
