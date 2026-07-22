// The progress dock's CONTEXT OBJECT — deliberately in its own module, separate from the
// <ProgressProvider> component (progress/ProgressContext.tsx).
//
// WHY THIS FILE EXISTS (the HMR duplicate-context bug):
//   When the context object was created at the top of ProgressContext.tsx — the same module that
//   exports the ProgressProvider component plus non-component helpers (useProgress, verb) — that
//   module was NOT eligible for React Fast Refresh (a module is only self-accepting when every
//   export is a component). So a Vite hot update re-evaluated it and propagated to its importers.
//   The result: the ALREADY-MOUNTED provider kept rendering the OLD `createContext()` identity while
//   the freshly re-imported `useProgress` read the NEW one — the consumer got the default value and
//   threw "useProgress must be used within <ProgressProvider>", blanking the page through the
//   ErrorBoundary. The fault trail shows it exactly: the frames disagree on the module specifier —
//     at useProgress   (…/progress/ProgressContext.tsx:173)
//     at ProgressProvider (…/progress/ProgressContext.tsx?t=1784572593404:28)
//
// TWO GUARDS, both required:
//   1. This module holds ONLY the context object + the type + the hook + the verb table — no React
//      component — so it is never part of a Fast-Refresh component boundary.
//   2. The context object is a process-wide singleton stashed on `globalThis`, so even if this
//      module IS evaluated twice (a second `?t=` specifier, a duplicated chunk), every copy hands
//      back the SAME React context identity and provider/consumer can never disagree.
//   3. Belt-and-braces in dev: if this module is ever hot-updated, force a FULL RELOAD rather than a
//      partial one (see the import.meta.hot block at the bottom).
import { createContext, useContext, type Context } from "react";
import type {
  ProgressJob,
  ProgressKind,
  ProcessingBatch,
  QueuedItemView,
  FailedItemView,
  SessionView,
} from "@lfb/shared";

// One unit of browser-initiated work handed to run(). `task` gets a `report` callback for determinate
// jobs; `invalidate` (query keys) refresh grids/counts when the batch succeeds.
export interface JobSpec {
  kind: ProgressKind;
  target: string;
  total?: number;
  unit?: string;
  task: (report: (p: { done?: number; total?: number; unit?: string }) => void) => Promise<unknown>;
}

export interface ProgressCtx {
  jobs: ProgressJob[];
  queued: number; // background job-queue backlog (not-yet-started tasks) — the dock's "+ N queued" footer
  queuedByOp: Partial<Record<ProgressKind, number>>; // per-op backlog split (processing.mdx §5)
  batches: ProcessingBatch[]; // active + recently-finished bulk-run batches (processing.mdx §4)
  queuedItems: QueuedItemView[]; // PENDING items as rows for the per-item table (processing.mdx §4.3)
  recentFailures: FailedItemView[]; // FAILED items + reason for the per-item table (processing.mdx §4.3)
  workers: { busy: number; budget: number } | null; // core-budget utilization (processing.mdx §3a)
  // This session + how the last one ended (crash_recovery.mdx §5.1). The input that lets an empty queue
  // say WHICH empty it is — Finished, Empty, or Interrupted — instead of always claiming the calm one.
  session: SessionView | null;
  processing: boolean; // any running job, pending backlog, OR active batch (processing.mdx §1)
  // A batch settled within the LINGER window and nothing is running now (processing.mdx §2.1). The nav
  // item keys off `processing || recentlyFinished` so a fast run stays reachable after it ends; the dock
  // keys off `processing` alone, because a card must still mean live work.
  recentlyFinished: boolean;
  run: (specs: JobSpec[], opts?: { invalidate?: unknown[][]; batchLabel?: string }) => Promise<void>;
}

// Guard 2 — the singleton. Keyed on globalThis so a duplicated module evaluation reuses the SAME
// React context identity instead of minting a second one that no mounted provider is feeding.
const CONTEXT_KEY = "__lfb_progress_context__";
type ContextHost = typeof globalThis & { [CONTEXT_KEY]?: Context<ProgressCtx | null> };
const host = globalThis as ContextHost;

export const ProgressReactContext: Context<ProgressCtx | null> =
  host[CONTEXT_KEY] ?? (host[CONTEXT_KEY] = createContext<ProgressCtx | null>(null));

/**
 * Read the dock's shared job state. THROWS when there is no <ProgressProvider> above the caller.
 *
 * The throw is deliberate and stays loud: with the singleton context above, a null value can no
 * longer mean "HMR handed me the wrong context object" — it can now only mean a genuine out-of-tree
 * mount (a consumer rendered outside the signed-in app shell in main.tsx, or a second React root).
 * That is a real bug we want to see, not one to swallow behind a silent no-op default.
 */
export function useProgress(): ProgressCtx {
  const ctx = useContext(ProgressReactContext);
  if (!ctx) {
    throw new Error(
      "useProgress must be used within <ProgressProvider> — this component mounted outside the " +
        "signed-in app shell (main.tsx Root) or in a second React root.",
    );
  }
  return ctx;
}

// The card verb per operation kind (webapp.mdx §11). Exported so the dock renders the same label.
const VERBS: Record<ProgressKind, string> = {
  scan: "Scanning",
  pin: "Pinning",
  publish: "Publishing",
  compress: "Compressing",
  transcribe: "Transcribing",
  describe: "Describing",
  // A TO DO Apply fan-out — ONE batch spanning several ops (processing_batches.mdx §1.2), so the verb
  // cannot name a single one.
  mixed: "Processing",
  // The third analysis transaction (ocr.mdx). "Reading text" rather than "OCR-ing": the dock card is read
  // by a person watching their files, and the verb should say what is happening to them.
  ocr: "Reading text in",
  hash: "Hashing",
  fingerprint: "Fingerprinting",
  ignore: "Ignoring",
  import: "Importing",
  install: "Installing",
  download: "Downloading",
  configure: "Configuring",
  // The two dedicated Videos scans (videos.mdx §4) — separate kinds on purpose.
  dedupe_scan: "Finding duplicates in",
  subset_scan: "Finding subsets in",
};
export function verb(kind: ProgressKind): string {
  return VERBS[kind] ?? "Working";
}

// Guard 3 — dev only. Editing this module can never be applied as a partial hot update: accept the
// update and immediately invalidate, which walks up to a full page reload. A mounted provider and a
// re-imported consumer therefore always come from one evaluation of one module.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot!.invalidate(
      "progress context module changed — full reload keeps the React context identity stable",
    );
  });
}
