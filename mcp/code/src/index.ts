// Entry point (pm/mcp.mdx §7). NO SHEBANG HERE — tsup's banner owns it (a second one breaks node).
//
// THE RULE: nothing is ever written to stdout except the JSON-RPC the SDK writes. Usage text, the startup
// line and every fault go to stderr (and WARN/ERROR also to error.err — logger.ts).
//
// Startup makes NO network call: tools/list must answer with the backend down, and a server that probed
// the backend first would look "failed to start" whenever the web app is simply stopped.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { apiBase, SERVER_NAME, SERVER_VERSION } from "./config.js";
import { log, logError, markStderrBroken } from "./logger.js";
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
    // Hard deadline: drain is bounded at 8 s, but nothing past this point may keep a dying server alive.
    setTimeout(() => process.exit(0), 10_000).unref();
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
  // CLIENT GONE = EXIT NOW (the EPIPE loop, 2026-10-19 — logger.ts). A failed write to stdout or stderr means the
  // session on the other end of the pipe is gone: no reply can ever be delivered, so there is nothing to drain.
  // Exit at once, without logging to stderr (that is the pipe that just failed).
  const clientGone = (stream: string) => (e: Error) => {
    markStderrBroken();
    logError({ file: "index.ts", operation: `${stream} pipe failed, client gone, exiting`, error: e });
    process.exit(0);
  };
  process.stdout.on("error", clientGone("stdout"));
  process.stderr.on("error", clientGone("stderr"));
  // A storm of uncaught exceptions is a loop, not a series of faults; past this many in a minute, exit rather
  // than let one keep a parentless process at full CPU writing the same line to error.err for hours.
  let uncaught = { count: 0, since: Date.now() };
  const onUncaught = (kind: string) => (e: unknown) => {
    const now = Date.now();
    if (now - uncaught.since > 60_000) uncaught = { count: 0, since: now };
    if ((e as NodeJS.ErrnoException | null)?.code === "EPIPE") markStderrBroken();
    logError({ file: "index.ts", operation: kind, error: e });
    if (++uncaught.count > 50) {
      logError({ file: "index.ts", operation: `${kind} storm (>50 in a minute), exiting`, error: e });
      process.exit(1);
    }
  };
  process.on("uncaughtException", onUncaught("uncaughtException"));
  process.on("unhandledRejection", onUncaught("unhandledRejection"));

  try {
    await host.server.connect(transport);
  } catch (e) {
    logError({ file: "index.ts", operation: "connect stdio transport", error: e });
    process.exit(EXIT_TRANSPORT);
  }
  log.info("main", `${SERVER_NAME} ${SERVER_VERSION} ready — ${TOOLS.length} tools, backend ${apiBase()}`);
}

void main(process.argv.slice(2));
