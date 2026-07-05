// A tiny, dependency-free bounded-concurrency runner (webapp.mdx §13). The SAME shape lives in
// backend/src/shared/concurrency.ts — the single "task view" the browser fan-out and the server runner
// share. Runs `fn` over `items` with at most `limit` in flight; extra items queue and start as slots
// free, so a card is added only when an item ACTUALLY starts (the dock reflects true in-flight work).
// Results come back in input order.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const n = items.length;
  const cap = Math.max(1, Math.min(limit || 1, n || 1));
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
