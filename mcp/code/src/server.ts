// The MCP server host (pm/mcp.mdx §7–§8): the low-level SDK Server, tools only, one result envelope.
//
// ENVELOPE — every tool answers with ONE text block holding JSON:
//   success : {"ok":true,"data":…}
//   failure : {"ok":false,"code":"…","message":"…","hint":"…"}  with isError:true
// A failure the user can act on (backend down, bad key, bad argument) is an isError RESULT, never a thrown
// protocol error: a thrown error reads to the model as "the tool is broken", a result reads as "here is what
// to do". Only a genuine bug escapes as an exception — and it is logged to error.err first.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { ApiError } from "./http.js";
import { INSTRUCTIONS } from "./instructions.js";
import { log, logError } from "./logger.js";
import { TOOLS } from "./tools/registry.js";

type Content = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): Content {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }, null, 1) }] };
}

function err(code: string, message: string, hint: string): Content {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, code, message, hint }) }], isError: true };
}

/** zod → JSON Schema for tools/list, computed once. `$schema` is dropped (clients do not need it). */
const TOOL_LIST = TOOLS.map((t) => {
  const schema = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  if (schema.type !== "object") schema.type = "object";
  return { name: t.name, description: t.description, inputSchema: schema };
});

export class McpServerHost {
  readonly server: Server;
  private inFlight = 0;

  constructor() {
    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    // tools/list never touches the network: it answers even with the backend down.
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }));
    this.server.setRequestHandler(CallToolRequestSchema, async (req) => this.call(req.params.name, req.params.arguments ?? {}));
  }

  async call(name: string, rawArgs: unknown): Promise<Content> {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return err("unknown_tool", `No tool named ${name}.`, `Available: ${TOOLS.map((t) => t.name).join(", ")}`);
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
      return err("bad_arguments", msg, "Fix the arguments and call again.");
    }
    this.inFlight++;
    const t0 = Date.now();
    try {
      const data = await tool.run(parsed.data);
      log.debug("tool", `${name} ok in ${Date.now() - t0} ms`);
      return ok(data);
    } catch (e) {
      if (e instanceof ApiError) return err(e.code, e.message, e.hint);
      logError({ file: "server.ts", operation: `tool ${name}`, error: e });
      return err("internal", (e as Error)?.message ?? String(e), "This is a bug in the Large File Bridge MCP server; details are in ~/T/_large_files_bridge/error.err.");
    } finally {
      this.inFlight--;
    }
  }

  /** Let in-flight calls finish (bounded) before the process exits. */
  async drain(maxMs: number): Promise<void> {
    const until = Date.now() + maxMs;
    while (this.inFlight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }
}
