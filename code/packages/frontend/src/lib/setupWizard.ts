// Global first-time storage-setup request bus (Transcribe.mdx §3.5). A derived-artifact action
// (Transcribe / Get AI details) that the backend answers with `needs_setup` — no Personal storage exists
// and nothing owns the file — calls requestStorageSetup(...) from anywhere (a launcher fn, the
// useTranscribeFile hook, a menu handler) WITHOUT threading a callback through every call site. The
// FirstTimeStorageWizardProvider mounted once at the app root subscribes and shows the wizard, then runs
// `retry` once a Personal storage exists so the user lands back on the action they clicked.
export interface StorageSetupRequest {
  /** The media file that triggered setup — shown in the wizard so the user sees what they were acting on. */
  mediaPath: string;
  /** A short verb phrase for the wizard copy, e.g. "transcribe" or "generate an AI description for". */
  actionLabel: string;
  /** Re-run the original action after setup completes (optional — a batch action may just re-plan). */
  retry?: () => void;
}

type Listener = (req: StorageSetupRequest) => void;

// Exactly one provider is mounted, so a single-slot listener is all we need (no multi-subscriber fan-out).
let listener: Listener | null = null;

/** The provider registers here; returns an unsubscribe for its effect cleanup. */
export function onStorageSetupRequested(cb: Listener): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

/** Ask the app to open the first-time setup wizard. No-op if the provider isn't mounted (shouldn't happen). */
export function requestStorageSetup(req: StorageSetupRequest): void {
  listener?.(req);
}
