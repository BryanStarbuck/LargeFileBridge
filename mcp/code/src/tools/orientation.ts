// lfb_whoami — the diagnostic entry point (ai/lfb_mcp.md §2), and lfb_files_list — the CLI's category query.
import { z } from "zod";
import { apiBase, credsFilePath, SERVER_NAME, SERVER_VERSION } from "../config.js";
import { CredentialError, keyFingerprint, readApiKey } from "../credentials.js";
import { ApiError, api } from "../http.js";
import { resolveUserPath } from "./shape.js";
import { defineTool } from "./types.js";

export const whoami = defineTool({
  name: "lfb_whoami",
  description:
    "Diagnose the Large File Bridge connection: is the backend up, does the local API key work, is the PDQ engine built, is Postgres storing fingerprints. Call first when anything fails.",
  schema: z.object({}),
  async run() {
    const out: Record<string, unknown> = { server: `${SERVER_NAME} ${SERVER_VERSION}`, api_base: apiBase(), credentials_file: credsFilePath() };
    try {
      out.api_key = { present: true, fingerprint: keyFingerprint(readApiKey()) };
    } catch (e) {
      out.api_key = e instanceof CredentialError ? { present: false, code: e.code, problem: e.message, fix: e.hint } : { present: false, problem: String(e) };
      return out;
    }
    try {
      const { data } = await api<Record<string, unknown>>("GET", "/fingerprints/info");
      out.backend = "up";
      out.authenticated = true;
      out.fingerprints = data;
    } catch (e) {
      if (e instanceof ApiError) {
        out.backend = e.code === "backend_down" ? "down" : "up";
        out.authenticated = e.code === "unauthorized" ? false : undefined;
        out.problem = { code: e.code, message: e.message, fix: e.hint };
      } else throw e;
    }
    return out;
  },
});

export const filesList = defineTool({
  name: "lfb_files_list",
  description:
    "List files under a directory (or every tracked root with scope \"all\") by Large File Bridge task category: compressible, gitignore, pulldown, notbackedup, transcribable, describable, ocrable.",
  schema: z.object({
    scope: z.string().min(1).describe('An absolute directory, or "all".'),
    categories: z.array(z.string()).optional().describe("Category keys; omit for every category with matches."),
  }),
  async run(a) {
    const q = new URLSearchParams({ scope: a.scope === "all" ? "all" : resolveUserPath(a.scope) });
    if (a.categories?.length) q.set("categories", a.categories.join(","));
    const { data } = await api<{ categories: Array<{ key: string; title: string; paths: string[] }> }>("GET", `/files/list?${q}`);
    // Paths per category can be long; show counts plus the first 200 of each.
    return {
      ...data,
      categories: data.categories.map((c) => ({ key: c.key, title: c.title, count: c.paths.length, paths: c.paths.slice(0, 200), truncated: c.paths.length > 200 })),
    };
  },
});
