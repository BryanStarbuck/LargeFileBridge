// Sign-in (charter: allow-listed Google SSO, no anonymous account). In localhost dev mode the
// backend authenticates the dev user, so this screen only shows when OAuth is configured.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.js";

export function SignInPage() {
  const { data } = useQuery({ queryKey: ["authConfig"], queryFn: api.authConfig });
  return (
    <div className="grid h-full place-items-center bg-slate-50">
      <div className="w-96 rounded-2xl border border-[var(--lfb-border)] bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold" style={{ color: "var(--lfb-primary)" }}>Large File Bridge</h1>
        <p className="mb-6 mt-1 text-sm text-black/60">Sync your large files across your own computers.</p>
        {data?.oauthConfigured ? (
          <a href="/api/v1/sign_in/sso"
            className="block rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-white">
            Sign in with Google
          </a>
        ) : (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
            Google sign-in is not configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, or run in
            local dev mode (LFB_DEV_AUTH=true).
          </p>
        )}
      </div>
    </div>
  );
}
