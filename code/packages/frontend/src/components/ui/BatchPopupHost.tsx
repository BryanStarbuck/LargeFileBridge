// The single global batch-popup host (dialogs.mdx §5.3). Mounted ONCE at the app root; it subscribes to the
// batch-popup bus (lib/batchPopup.ts) and renders the WarningPopup for whatever transcribe/describe
// WarningDef a launcher requested. This is what lets the page action-links row and the ⋮ / right-click menu
// open the SAME "great pop-up" the Transcribable/Describable metric tile opens (the tile mounts its own
// WarningPopup inside MetricsStrip; every other entry point routes through here).
import { useEffect, useState } from "react";
import { onBatchPopupRequested } from "../../lib/batchPopup.js";
import { WarningPopup } from "./WarningPopup.js";
import type { WarningDef } from "./warnings/registry.js";

export function BatchPopupHost() {
  const [def, setDef] = useState<WarningDef | null>(null);

  useEffect(() => onBatchPopupRequested((next) => setDef(next)), []);

  if (!def) return null;
  return <WarningPopup warning={def} onClose={() => setDef(null)} />;
}
