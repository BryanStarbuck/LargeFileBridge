// Mounted ONCE at the app root (main.tsx). Shows the fingerprint dialog when openFingerprints(...) fires.
import { useEffect, useState } from "react";
import { onFingerprintsRequested, type FingerprintRequestUi } from "../../lib/fingerprints.js";
import { FingerprintDialog } from "./FingerprintDialog.js";

export function FingerprintProvider() {
  const [req, setReq] = useState<FingerprintRequestUi | null>(null);
  useEffect(() => onFingerprintsRequested((r) => setReq(r)), []);
  if (!req) return null;
  return <FingerprintDialog req={req} onClose={() => setReq(null)} />;
}
