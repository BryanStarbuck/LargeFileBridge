/// <reference types="vite/client" />

declare module "*.yaml?raw" {
  const content: string;
  export default content;
}

// Parsed at BUILD time by vite.config.ts's `yamlParsedAtBuildTime` plugin, so the browser never ships a
// YAML parser (performance.mdx P-54). `unknown` on purpose: the importer narrows it to the shape it
// expects and keeps its own fallback, exactly as it did when this arrived as text.
declare module "*.yaml?parsed" {
  const doc: unknown;
  export default doc;
}
