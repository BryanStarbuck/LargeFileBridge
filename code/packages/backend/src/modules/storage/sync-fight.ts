// THE TUG-OF-WAR BREAKER — never fight another computer over a shared file (backward_compatibility.md §5).
//
// THE SHAPE IT CATCHES. Two builds that disagree about how a shared document should be SPELLED — an older
// one that re-stamps, re-orders, drops a field, or keeps a duplicate, and a newer one that does not — each
// rewrite the other's bytes on every pass. Neither is "wrong" from its own point of view, the git backbone
// faithfully carries every rewrite, and the result is a commit every few minutes forever, a multi-megabyte
// re-merge on every computer on every pass, and the "the page is hanging" report that started this. It
// happened twice in two months (performance.mdx P-51 and P-56/P-57), each time from a different field.
//
// The specific causes get specific fixes. This is the GENERAL one, for the next cause nobody has found yet:
// a newer build can't fix older code, but it can decline to keep answering it.
//
// THE RULE. We are about to write bytes TO over a shared file currently holding bytes FROM. If FROM is not
// what WE last wrote there (someone else put it there), and we have already written this exact TO over this
// exact FROM `FIGHT_THRESHOLD` times in the last `FIGHT_WINDOW_MS`, then another writer keeps turning our
// answer back into theirs. Writing it a fourth time changes nothing but the commit count — so we stop, log
// ONE error naming the file and the computers that are behind, and keep Local Storage authoritative.
//
// WHY IT CANNOT BLOCK A REAL CHANGE. A real change produces NEW bytes: a new decision, a new deletion, a new
// peer's merge — a different (FROM, TO) pair, which the breaker has never counted. And a user toggling a
// decision back and forth produces the same pairs, but every FROM there is bytes WE wrote, which is excluded
// by the first condition. Only a repeated, EXTERNAL reversal of the same answer counts.
//
// It is a CACHE of our own history, persisted so a restart (which the dev app does constantly) does not
// reset a trip and re-open the fight. Every failure degrades to "write as before".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveStateDir } from "../../config/state-dir.js";
import { log } from "../../shared/logging.js";

/** How many identical external reversals prove a fight. Three: one is a race, two is a coincidence. */
const FIGHT_THRESHOLD = Math.max(2, Number(process.env.LFB_SYNC_FIGHT_THRESHOLD) || 3);
/** How long a reversal is remembered. A day: an older peer's pass runs every 10–15 minutes. */
const FIGHT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pairs kept per file — enough to see a fight, bounded so the state file stays small. */
const MAX_PAIRS = 24;

interface Pair {
  from: string;
  to: string;
  at: number;
}
interface FileState {
  /** Hash of the bytes WE last wrote here — what tells our own writes from someone else's. */
  ourLast: string | null;
  pairs: Pair[];
  /** Set while the breaker holds this file: when it tripped, and on which pair. */
  fight?: { since: number; from: string; to: string; held: number };
}

export interface SyncFight {
  file: string;
  /** ISO time the breaker first held this file. */
  since: string;
  /** How many writes it has declined since then. */
  held: number;
}

const state = new Map<string, FileState>();
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;
const stateFile = (): string => path.join(resolveStateDir(), "sync-fights.json");

const hash = (text: string): string => crypto.createHash("sha1").update(text).digest("hex");

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as { schema?: number; files?: Record<string, FileState> };
    if (raw.schema !== 1 || !raw.files) return;
    for (const [f, st] of Object.entries(raw.files)) state.set(f, st);
  } catch {
    /* absent/corrupt — an empty history only means a fight takes three more passes to recognise */
  }
}

function saveSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const file = stateFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ schema: 1, files: Object.fromEntries(state) }));
      fs.renameSync(tmp, file);
    } catch (e) {
      log.warn("sync-fight", `state save failed (harmless — a fight is simply re-detected): ${(e as Error).message}`);
    }
  }, 5_000);
  saveTimer.unref?.();
}

/**
 * Write `content` to a SHARED file (one inside a sync repo's working tree) unless its bytes already match —
 * the shared twin of `writeIfDifferent`, with the tug-of-war breaker in front of the write.
 *
 * Returns whether the file's bytes changed. A write the breaker declines returns `false`, exactly like an
 * unchanged file: to the caller, and to the git backbone it would otherwise have armed, nothing happened.
 */
export function writeSharedIfDifferent(file: string, content: string): boolean {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    /* absent — a first write can never be a fight */
  }
  if (existing === content) return false;

  load();
  const now = Date.now();
  const st: FileState = state.get(file) ?? { ourLast: null, pairs: [] };
  const from = existing === null ? "" : hash(existing);
  const to = hash(content);
  // Bytes we did not write: this is the only kind of FROM that can be the far side of a fight.
  const external = existing !== null && from !== st.ourLast;
  st.pairs = st.pairs.filter((p) => now - p.at < FIGHT_WINDOW_MS);

  if (external) {
    const repeats = st.pairs.filter((p) => p.from === from && p.to === to).length;
    if (repeats >= FIGHT_THRESHOLD) {
      const first = !st.fight || st.fight.from !== from || st.fight.to !== to;
      st.fight = first ? { since: now, from, to, held: 1 } : { ...st.fight!, held: st.fight!.held + 1 };
      state.set(file, st);
      saveSoon();
      if (first) reportFight(file, repeats);
      return false;
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  st.ourLast = to;
  if (external) st.pairs = [...st.pairs, { from, to, at: now }].slice(-MAX_PAIRS);
  // A write the breaker allowed on a DIFFERENT pair means the other side moved on: the fight is over.
  if (st.fight && (st.fight.from !== from || st.fight.to !== to)) {
    log.info("sync-fight", `${file}: the other writer changed its answer — writing normally again`);
    delete st.fight;
  }
  state.set(file, st);
  saveSoon();
  return true;
}

/** ONE error per fight, naming the file and — when the registry can say — the computers that are behind. */
function reportFight(file: string, repeats: number): void {
  const base =
    `${file}: another computer has turned this computer's version of this shared file back into its own ` +
    `${repeats} times in the last day, byte for byte. Writing it again would only add another commit, so ` +
    `this computer has STOPPED rewriting it (nothing is lost — Local Storage keeps this computer's copy, and ` +
    `any NEW change here is still written). This is how an older Large File Bridge and a newer one ` +
    `disagree about how a document is spelled. See backward_compatibility.md §5.`;
  void (async () => {
    let peers = "";
    try {
      const { stalePeersAcrossStorages } = await import("../schedule/self-update.service.js");
      const { defectsOfBuild } = await import("@lfb/shared");
      const stale = await stalePeersAcrossStorages();
      if (stale.length > 0) {
        peers =
          ` Computers on an older build: ` +
          stale
            .map((p) => `${p.device} (build ${p.build}${defectsOfBuild(p.build).length ? `: ${defectsOfBuild(p.build).map((d) => d.id).join(", ")}` : ""})`)
            .join("; ") +
          ` — updating them ends this.`;
      }
    } catch {
      /* the registry is a courtesy here; the fact of the fight is the message */
    }
    log.error("sync-fight", base + peers);
  })();
}

/** Every shared file the breaker is holding right now — for the health report and the UI. */
export function listSyncFights(): SyncFight[] {
  load();
  const now = Date.now();
  const out: SyncFight[] = [];
  for (const [file, st] of state) {
    if (!st.fight) continue;
    // A fight whose evidence has aged out is over: the next write attempt re-decides from scratch.
    if (st.pairs.every((p) => now - p.at >= FIGHT_WINDOW_MS)) continue;
    out.push({ file, since: new Date(st.fight.since).toISOString(), held: st.fight.held });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** TEST-ONLY: forget every file's history, in memory and on disk. */
export function resetSyncFights(): void {
  state.clear();
  loaded = false;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.rmSync(stateFile(), { force: true });
  } catch {
    /* none */
  }
}
