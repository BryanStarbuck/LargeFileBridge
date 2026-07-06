// The credentials-missing popup for AI description (ai_credentials.mdx §2). Shown when the user clicks
// "Generate description" but no vision-provider key resolves on this machine (config.yaml → env vars →
// the shared GoogleCloud/apikey.yaml). It explains that the credentials file wasn't found and offers
// exactly two buttons:
//   • Close        — dismiss and stay on the page.
//   • Instructions — open the full "AI credentials" setup page in a NEW TAB (/ai-credentials), which
//                    gives the exact file path, the YAML format, and the placeholder to fill in.
// Matches the app's hand-rolled modal pattern (ReposPage AddRepoDialog): a fixed overlay, backdrop-click
// to close, inner stopPropagation. No secret value is ever shown here.
import { KeyRound, ExternalLink } from "lucide-react";

export function CredentialsMissingDialog({
  reason,
  onClose,
}: {
  /** The backend's honest reason (e.g. "no AI provider configured for video — add a key for Gemini…"). */
  reason?: string;
  onClose: () => void;
}) {
  const openInstructions = () => {
    // A full page in a NEW TAB so the user keeps this viewer open while they set up the key.
    window.open("/ai-credentials", "_blank", "noopener");
  };
  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="w-[28rem] max-w-full rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="creds-missing-title"
      >
        <div className="flex items-center gap-2 text-amber-800">
          <KeyRound className="h-5 w-5" />
          <h2 id="creds-missing-title" className="text-lg font-semibold">
            AI credentials not found
          </h2>
        </div>
        <p className="mt-2 text-sm text-black/70">
          {reason ??
            "Large File Bridge couldn’t find an AI provider key on this computer, so it can’t generate a description yet."}
        </p>
        <p className="mt-2 text-sm text-black/70">
          Generating a description needs a <b>Gemini</b> API key (the only provider that describes video).
          The credentials file that holds it wasn’t found. Open the instructions to see exactly where the
          file goes, its format, and what to put inside.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--lfb-border)] px-4 py-2 text-sm text-black/70 hover:bg-black/5"
          >
            Close
          </button>
          <button
            onClick={openInstructions}
            className="flex items-center gap-2 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm text-white hover:opacity-90"
          >
            <ExternalLink className="h-4 w-4" /> Instructions
          </button>
        </div>
      </div>
    </div>
  );
}
