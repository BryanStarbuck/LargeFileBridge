// Mounted ONCE at the app root (main.tsx). Subscribes to the compress-inside bus (compress_inside.mdx §2)
// and shows the pop-over dialog when the directory ⋮ item or a page "Compress all…" link fires
// openCompressInside(...). One provider, one dialog — no per-call-site modal wiring.
import { useEffect, useState } from "react";
import { onCompressInsideRequested, type CompressInsideRequestUi } from "../../lib/compressInside.js";
import { CompressInsideDialog } from "./CompressInsideDialog.js";

export function CompressInsideProvider() {
  const [req, setReq] = useState<CompressInsideRequestUi | null>(null);
  useEffect(() => onCompressInsideRequested((r) => setReq(r)), []);
  if (!req) return null;
  return <CompressInsideDialog req={req} onClose={() => setReq(null)} />;
}
