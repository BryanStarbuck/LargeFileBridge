import type { z } from "zod";

/** One MCP tool: name, the description the model reads, a zod schema (→ JSON Schema), and its body. */
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> {
  return t;
}
