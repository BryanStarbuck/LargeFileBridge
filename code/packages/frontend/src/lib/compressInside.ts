// Global "Compress videos & images inside" request bus (compress_inside.mdx §2). The directory ⋮ item
// ("Compress videos/images inside…") and the page-level "Compress all videos…/images…" links call
// openCompressInside(...) from anywhere WITHOUT threading a modal callback through every call site. The
// CompressInsideProvider mounted once at the app root subscribes and shows the pop-over dialog.
export interface CompressInsideRequestUi {
  /** The directory whose media to compress (the dialog shows this path). */
  root: string;
  /** Which kind checkboxes start checked. Directory ⋮ opens both; a page "…videos"/"…images" link opens one. */
  images: boolean;
  videos: boolean;
}

type Listener = (req: CompressInsideRequestUi) => void;

// Exactly one provider is mounted, so a single-slot listener is all we need (no multi-subscriber fan-out).
let listener: Listener | null = null;

/** The provider registers here; returns an unsubscribe for its effect cleanup. */
export function onCompressInsideRequested(cb: Listener): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

/** Ask the app to open the Compress-inside dialog. No-op if the provider isn't mounted (shouldn't happen). */
export function openCompressInside(root: string, opts?: { images?: boolean; videos?: boolean }): void {
  listener?.({ root, images: opts?.images ?? true, videos: opts?.videos ?? true });
}
