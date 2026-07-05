// A tiny, dependency-free bounded-concurrency runner (webapp.mdx §13). The SAME shape lives in
// frontend/src/lib/concurrency.ts — the single "task view" the browser fan-out and the server runner
// share. No worker threads / piscina: scan, IPFS, hashing and even ffmpeg supervision are I/O- or
// process-bound, so bounded async concurrency on the event loop is the right, lightweight tool.
//
// Runs `fn` over `items` with at most `limit` in flight at once; extra items queue and start as slots
// free. Results are returned in input order. A rejection from any `fn` rejects the whole run (after the
// already-started tasks settle) — callers that want per-item isolation should catch inside `fn`.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const n = items.length;
  const cap = Math.max(1, Math.min(limit | 0 || 1, n || 1));
  let next = 0;
  async function worker(): Promise<void> {
    while (next < n) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
