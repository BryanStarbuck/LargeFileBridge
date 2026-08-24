// THE BACKFILL'S YAML READER — raw `fs.readFileSync` + `YAML.parse` + the zod schema, and nothing else.
//
// WHY NOT `readYaml()` (database_migration.mdx §4.2). `yaml-store`'s `rawCache` is 4,096 entries with FIFO
// eviction (`yaml-store.ts:31, 93-96`). The sidecar area alone walks 29,138 documents; pushing them through
// that cache overwrites the live working set ~7 times over and evicts every hot unit config — degrading the
// exact request this entire workstream exists to speed up. A one-shot migration must not evict a warm cache
// on its way past.
//
// This is also what every existing boot migration already does (`migrate-sync-to-pin.ts:271-275`), so the
// backfill is not inventing a second reading discipline; it is using the one the migrations already have.
//
// The thrown error is the POINT, not an accident: mechanic (c) needs a message to put in the reject table,
// and `readSidecar`'s habit of swallowing parse failures is precisely how two unreadable sidecars sat on
// this machine unnoticed. Callers catch, `ctx.reject(file, message)`, and continue.
import fs from "node:fs";
import YAML from "yaml";
import type { z } from "zod";

/** Parse and validate `file`. THROWS on a missing file, a YAML syntax error, or a schema violation. */
export function readRawYaml<T>(file: string, schema: z.ZodType<T>): T {
  const text = fs.readFileSync(file, "utf8");
  const doc = YAML.parse(text) ?? {};
  return schema.parse(doc);
}

/** Parse and validate `file`, or return null when it does not exist. Any OTHER failure still throws. */
export function readRawYamlIfPresent<T>(file: string, schema: z.ZodType<T>): T | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const doc = YAML.parse(text) ?? {};
  return schema.parse(doc);
}
