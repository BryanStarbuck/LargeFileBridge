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
      <div className="grid h-full place-items-center overflow-y-auto bg-slate-50 p-6">
        <div className="w-full max-w-xl rounded-2xl border border-[var(--lfb-border)] bg-white p-8 shadow-sm">
          <h1 className="text-center text-xl font-semibold" style={{ color: "var(--lfb-primary)" }}>
            Large File Bridge
          </h1>
          <p className="mb-6 mt-1 text-center text-sm text-black/60">
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
    <div className="grid h-full place-items-center bg-slate-50">
      <div className="w-96 rounded-2xl border border-[var(--lfb-border)] bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold" style={{ color: "var(--lfb-primary)" }}>Large File Bridge</h1>
        <p className="mb-6 mt-1 text-sm text-black/60">Pin your large files across your own computers.</p>
        <button type="button" onClick={() => void startGoogleSignIn().catch((e) => clientLog.error("SignInPage.startGoogleSignIn", e))}
          className="block w-full rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-white">
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
