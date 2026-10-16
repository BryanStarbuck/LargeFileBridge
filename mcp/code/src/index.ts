// Entry point (pm/mcp.mdx §7). NO SHEBANG HERE — tsup's banner owns it (a second one breaks node).
//
// THE RULE: nothing is ever written to stdout except the JSON-RPC the SDK writes. Usage text, the startup
// line and every fault go to stderr (and WARN/ERROR also to error.err — logger.ts).
//
// Startup makes NO network call: tools/list must answer with the backend down, and a server that probed
// the backend first would look "failed to start" whenever the web app is simply stopped.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { apiBase, SERVER_NAME, SERVER_VERSION } from "./config.js";
import { log, logError } from "./logger.js";
import { McpServerHost } from "./server.js";
import { TOOLS } from "./tools/registry.js";

const EXIT_USAGE = 1;
const EXIT_TRANSPORT = 5;

async function main(argv: string[]): Promise<void> {
  if (argv[0] !== "serve") {
    process.stderr.write(
      `Large File Bridge MCP server ${SERVER_VERSION}\n` +
        `usage: lfb-mcp serve\n\n` +
        `Register with Claude Code:\n  claude mcp add ${SERVER_NAME} -- node ${process.argv[1]} serve\n`,
    );
    process.exit(EXIT_USAGE);
  }
  const host = new McpServerHost();
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (why: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("main", `shutting down (${why})`);
    await host.drain(8_000);
    try {
      await host.server.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("end", () => void shutdown("stdin closed"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  // ORPHAN WATCHDOG (memory incident 2026-10-15). stdin EOF is the normal signal that the Claude Code session
  // that spawned us is gone — but if the session dies hard while some other process still holds the write end
  // of our stdin pipe, EOF never comes and this server would live forever. Re-parenting is the tell: when the
  // spawning process exits, POSIX hands us to init/launchd (a new ppid). Unref'd: it never keeps us alive.
  const parentAtStart = process.ppid;
  if (process.platform !== "win32" && parentAtStart !== 1) {
    setInterval(() => {
      if (process.ppid !== parentAtStart) void shutdown(`parent ${parentAtStart} exited`);
    }, 15_000).unref();
  }
  process.on("uncaughtException", (e) => logError({ file: "index.ts", operation: "uncaughtException", error: e }));
  process.on("unhandledRejection", (e) => logError({ file: "index.ts", operation: "unhandledRejection", error: e }));

  try {
    await host.server.connect(transport);
  } catch (e) {
    logError({ file: "index.ts", operation: "connect stdio transport", error: e });
    process.exit(EXIT_TRANSPORT);
  }
  log.info("main", `${SERVER_NAME} ${SERVER_VERSION} ready — ${TOOLS.length} tools, backend ${apiBase()}`);
}

void main(process.argv.slice(2));
