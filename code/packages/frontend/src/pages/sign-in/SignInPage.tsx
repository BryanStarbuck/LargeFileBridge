// Sign-in (charter: allow-listed Google SSO, no anonymous account). In localhost dev mode the
// backend authenticates the dev user, so this screen only shows when OAuth is configured — or when
// it ISN'T, in which case we show exactly which credentials file to create on this computer.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.js";
import { startGoogleSignIn } from "../../api/authCore.js";
import { CredentialsSetupCard } from "../../components/CredentialsSetupCard.js";
import { clientLog } from "../../lib/clientLog.js";

export function SignInPage() {
  const { data } = useQuery({ queryKey: ["authConfig"], queryFn: api.authConfig });

  if (data && !data.oauthConfigured) {
    // Credentials missing on this computer — guide the user to create the file.
    return (
      <div className="grid h-full place-items-center overflow-y-auto bg-[var(--lfb-surface-2)] p-6">
        <div className="w-full max-w-xl rounded-2xl border border-[var(--lfb-border)] bg-white p-8 shadow-[var(--lfb-shadow-md)]">
          <h1 className="text-center text-xl font-semibold tracking-tight" style={{ color: "var(--lfb-primary)" }}>
            Large File Bridge
          </h1>
          <p className="mb-6 mt-1.5 text-center text-sm text-black/55">
            Pin your large files across your own computers.
          </p>
          <CredentialsSetupCard
            info={data.credentialsFile}
            redirectUri={data.redirectUri}
            allowedDomains={data.allowedDomains}
            devAuth={data.devAuth}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full place-items-center bg-[var(--lfb-surface-2)] p-6">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--lfb-border)] bg-white p-8 text-center shadow-[var(--lfb-shadow-md)]">
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: "var(--lfb-primary)" }}>
          Large File Bridge
        </h1>
        <p className="mb-6 mt-1.5 text-sm text-black/55">Pin your large files across your own computers.</p>
        <button type="button" onClick={() => void startGoogleSignIn().catch((e) => clientLog.error("SignInPage.startGoogleSignIn", e))}
          className="w-full lfb-btn lfb-btn-primary lfb-btn-lg">
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
