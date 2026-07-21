// The shared content-region skeleton for pages whose body depends on one query (performance.mdx
// Aspect 6b: a page renders its shell immediately — the header, back link, and title never wait on
// the server; only the content region pulses until the data lands).
export function PageSkeleton({ blocks = 3 }: { blocks?: number }) {
  return (
    <div className="animate-pulse space-y-3" aria-busy="true" aria-label="Loading">
      <div className="h-6 w-1/3 rounded bg-slate-100" />
      {Array.from({ length: blocks }, (_, i) => (
        <div key={i} className="h-20 rounded bg-slate-100" />
      ))}
    </div>
  );
}
