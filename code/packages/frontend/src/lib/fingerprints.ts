// Global "Calculate perceptual fingerprints" request bus (perceptual_fingerprint.mdx §FD.6). The directory
// right-click/⋮ item and the file item call openFingerprints(...) from anywhere; the FingerprintProvider
// mounted once at the app root shows the dialog. Same single-slot shape as lib/compressInside.ts.
export type FingerprintRequestUi = { root: string } | { paths: string[] };

type Listener = (req: FingerprintRequestUi) => void;
let listener: Listener | null = null;

export function onFingerprintsRequested(cb: Listener): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

export function openFingerprints(req: FingerprintRequestUi): void {
  listener?.(req);
}
