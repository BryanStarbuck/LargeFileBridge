// Composes ProgressJob.note — the "what is happening right now" line — for work that runs MANY items at
// once (webapp.mdx §10.2 / §12a). A pin pass, a pull-down and the full pass all fan out over a bounded
// limiter, so at any instant several files are in flight and one of them is usually the interesting one.
//
// WHY A COMPOSER AND NOT A BARE STRING. The two things a watching user needs are the PHASE ("fetching",
// "reading this computer's pin list") and the ITEM the phase is on right now — and neither alone is the
// answer. A phase with no item cannot distinguish a long file from a wedged one; an item with no phase
// cannot say whether we are uploading it, fetching it, or writing it to disk. The composer holds both,
// plus the per-item byte detail, and renders ONE line no matter how many workers are running.
//
// It also THROTTLES. The byte callbacks below it fire per network chunk — thousands of times a second on a
// fast transfer — and every one of them would otherwise walk the registry and bump the event topic. Phase
// and item transitions are structural and always emit at once; byte ticks coalesce onto a ~250 ms floor.
import path from "node:path";
import type { Reporter } from "./progress.registry.js";

/** How often a pure byte/percentage tick may repaint the note. Structural changes ignore this. */
const TICK_FLOOR_MS = 250;

export class WorkNote {
  private phaseText = "";
  // Insertion-ordered: the FIRST item still running is the one the line names, so the note follows the
  // oldest in-flight file rather than jittering between workers on every tick.
  private readonly live = new Map<string, { label: string; detail?: string }>();
  private lastEmit = 0;
  private lastLine: string | null = null;

  constructor(private readonly report?: Reporter) {}

  /** Set the phase (""/omitted clears the line). Always repaints — a phase change is never noise. */
  phase(text: string): void {
    this.phaseText = text;
    this.emit(true);
  }

  /** An item started. `label` defaults to the basename, which is what the user recognizes. */
  start(key: string, label?: string): void {
    this.live.set(key, { label: label ?? path.basename(key) });
    this.emit(true);
  }

  /** Per-item detail — the byte/blocks read that makes a big file's progress visible. Throttled. */
  detail(key: string, text: string): void {
    const item = this.live.get(key);
    if (!item) return; // finished (or never started) — a late tick must not resurrect its line
    item.detail = text;
    this.emit(false);
  }

  /**
   * `detail` for a HIGH-FREQUENCY source, where building the string is the cost worth avoiding.
   *
   * A `cat` of a 4 GB video fires its byte callback once per ~64 KB chunk — tens of thousands of times a
   * second across a fan-out — and all but ~4 of those per second are thrown away by the tick floor. This
   * checks the floor FIRST and only then asks the caller to format the line.
   */
  detailLazy(key: string, make: () => string): void {
    if (!this.report) return;
    if (!this.live.has(key)) return;
    if (Date.now() - this.lastEmit < TICK_FLOOR_MS) return; // not due — don't pay for a line nobody sees
    this.detail(key, make());
  }

  /** An item settled (success OR failure) — it leaves the line immediately. */
  finish(key: string): void {
    if (this.live.delete(key)) this.emit(true);
  }

  /** Compose and push the line. `force` bypasses the tick floor (phase/item transitions). */
  private emit(force: boolean): void {
    if (!this.report) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < TICK_FLOOR_MS) return;
    const line = this.compose();
    if (line === this.lastLine) return; // nothing changed — don't churn the poll payload
    this.lastEmit = now;
    this.lastLine = line;
    this.report({ note: line });
  }

  private compose(): string {
    const first = this.live.values().next();
    if (first.done) return this.phaseText; // no item in flight — the phase IS the whole line
    const item = first.value;
    // "+N more" sits with the NAME, not at the end. The byte reading on this line is ONE file's, and this
    // is the only thing that says so — at the end it was the first thing the dock's 360px card truncated
    // away. What was left looked like a single transfer whose total grew on its own: the named file
    // finished, the line handed over to the next-oldest still running, and that one was already part-way
    // through because it had been transferring in parallel all along (≈41.8 MB of 85.2 MB, where the line
    // had just been reading a 16 MB file). The count moved in the same instant; the context did not survive.
    const more = this.live.size - 1;
    const name = more > 0 ? `${item.label} +${more} more` : item.label;
    const head = this.phaseText ? `${this.phaseText} ${name}` : name;
    return item.detail ? `${head} · ${item.detail}` : head;
  }
}

/**
 * Yield to the event loop so a note that was just reported can actually be SERVED.
 *
 * The slowest parts of a pin pass are SYNCHRONOUS (parsing and rewriting a six-figure-line ledger, merging
 * manifests). Reporting "reconciling peer changes" immediately before one of those blocks is useless on its
 * own: the loop is then held for the whole block, so `GET /api/progress` cannot answer until the work the
 * note describes is already over. One macrotask hop hands the poll its turn first, which is the difference
 * between a card that names the slow step and a card that names it only in hindsight.
 */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
