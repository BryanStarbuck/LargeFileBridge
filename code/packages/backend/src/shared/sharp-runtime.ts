// The ONE place `sharp` enters this process (memory.mdx — the 4 GB RSS incident).
//
// WHY THIS MODULE EXISTS. `sharp.cache()` and `sharp.concurrency()` are PROCESS-GLOBAL libvips settings,
// not per-pipeline options. They used to be set as a side effect of importing media/perceptual.service.ts,
// and three other sharp users (compress/image-encode.ts, media/poster.service.ts, videos/exec.ts) carried
// comments asserting that "the globals are set once by perceptual.service.ts" — an assumption nothing
// enforced. Whether they were actually applied depended entirely on whether some *unrelated* module had
// already pulled perceptual.service into the module graph. A process that served posters without ever
// fingerprinting anything ran libvips on FULL defaults, and an import-order change could silently
// re-introduce that at any time.
//
// MEASURED, 12 real photos x 4 poster-path passes, this machine (24 cores):
//   defaults      71MB -> 324MB RSS, still 324MB after idle+GC  (vips concurrency 16, 50MB op cache)
//   configured    71MB -> 173MB RSS, plateaus ~210MB over 20 passes
// ~46% of resident memory, and the leaked half is INVISIBLE to the heap warning: heapUsed stayed at 8MB
// throughout. That is precisely the production signature in error.err — "rss=10548MB ... heapUsed=92MB,
// external=10MB ... children=0" with nothing in flight.
//
// THE FIX IS STRUCTURAL, NOT A CALL SITE. Importing sharp from anywhere else re-opens the hole, so:
//   * every sharp user in this package imports the configured instance from HERE;
//   * sharp-runtime.import-guard.spec.ts fails the build if any module imports "sharp" directly.
// This file must stay a LEAF (no imports beyond sharp itself) so that it can never sit downstream of the
// subsystem whose memory it is bounding.
import sharp from "sharp";

// cache(false) — libvips keeps an operation/file cache (50 MB + 20 open files by default). Our access
// pattern is "touch each file once and never again", so the cache has a ~0% hit rate: it is pure retained
// native bytes, and they are retained for the life of the process.
sharp.cache(false);

// concurrency(1) — libvips runs a thread pool PER PIPELINE sized to the core count (16 on this box), and
// each worker carries its own tile buffers and malloc arena, which macOS does not hand back. We already
// fan out at the JOB level (the queue's core budget), so per-pipeline threading only multiplies arenas by
// cores. Leaving this at the default is how one poster request reserves 16 arenas' worth of RSS forever.
sharp.concurrency(1);

/** The process-wide configured `sharp`. Import this — never `sharp` itself (see the guard spec). */
export default sharp;
export { sharp };
