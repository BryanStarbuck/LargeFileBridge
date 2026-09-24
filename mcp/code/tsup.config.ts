import { defineConfig } from "tsup";

// ONE self-contained, directly executable file (pm/mcp.mdx §5.3). Claude Code spawns the server by absolute
// path with an unrelated working directory and PATH, so every dependency — the MCP SDK included — is bundled
// (noExternal) and nothing is split into sibling chunks. Not minified: stderr stack traces are the only
// debugging channel a human gets from inside an editor, so they must stay readable. The banner owns the
// shebang; src/index.ts must not carry one (esbuild would emit it twice and node would refuse the file).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __lfbCreateRequire } from 'node:module'; const require = __lfbCreateRequire(import.meta.url);" },
  onSuccess: "node -e \"require('fs').chmodSync('dist/index.js', 0o755)\"",
});
