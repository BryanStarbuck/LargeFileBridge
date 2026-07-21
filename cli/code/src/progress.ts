// Live progress line (cli.mdx §4.7): spinner frame + phase text + elapsed seconds, redrawn in
// place on STDERR, so a slow calculation never looks hung. TTY-gated — when stderr is piped or
// captured nothing animates and the ordinary one-line status messages remain the record. stdout is
// never touched (pure paths, §4.3), and the line is fully erased before any real output prints.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REDRAW_MS = 100;
const ERASE = "\r\x1b[2K"; // carriage return + clear-to-end-of-line

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private startedAt = 0;
  private message = "";

  /** Begin (or retarget) the progress line. No-op when stderr is not a TTY. */
  start(message: string): void {
    this.message = message;
    if (!process.stderr.isTTY) return;
    this.startedAt = this.startedAt || Date.now();
    if (this.timer) return; // already animating — just the message changed
    this.timer = setInterval(() => this.draw(), REDRAW_MS);
    this.timer.unref();
    this.draw();
  }

  private draw(): void {
    const secs = Math.floor((Date.now() - this.startedAt) / 1000);
    const frame = FRAMES[this.frame++ % FRAMES.length];
    process.stderr.write(`${ERASE}${frame} ${this.message} ${secs}s`);
  }

  /** Erase the line and stop. Always safe to call — including on error paths (cleanup contract). */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.startedAt = 0;
    process.stderr.write(ERASE);
  }
}
