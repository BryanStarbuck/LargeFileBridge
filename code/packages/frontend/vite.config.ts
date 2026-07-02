import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Grant read access up to the LargeFileBridge repo root so we can import pm/left_bar.yaml?raw
// (left_bar.mdx §AC4 — the frontend renders the nav straight from the yaml, no code copy).
const repoRoot = path.resolve(__dirname, "../../..");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 8080,
    strictPort: true,
    fs: { allow: [repoRoot] },
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
