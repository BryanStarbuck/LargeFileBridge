// Landing for the OpenAuthFederated redirect (/sso-callback). Google sends the browser to the
// backend's /api/v1/oauth_callback; on success the backend bounces here (an absolute SPA-origin url).
// We finish the handshake — completeRedirectCallback() rehydrates the session from the now-set cookie
// — then hard-navigate to redirectUrlComplete so the whole app re-boots with a live session (getToken
// then attaches a Bearer to every /api call). Rendered by main.tsx before the auth gate, since the
// user is not yet "authenticated" from /auth/me's point of view.
import { useEffect, useState } from "react";
import { authCore } from "../../api/authCore.js";
import { clientLog } from "../../lib/clientLog.js";

// Module-level guard: React 18 StrictMode double-invokes effects in dev — run the handshake once.
let ran = false;

export function SsoCallbackPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ran) return;
    ran = true;
    authCore
      .completeRedirectCallback()
      .then((res) => {
        if (res.error) {
          clientLog.error("SsoCallbackPage.completeRedirectCallback", res.error);
          setError(res.error.message);
          return;
        }
        // Absolute or relative — resolve to a same-origin path and replace so back doesn't re-fire.
        const target = res.redirectTo
          ? new URL(res.redirectTo, window.location.origin).pathname
          : "/";
        window.location.replace(target || "/");
      })
      .catch((e) => {
        clientLog.error("SsoCallbackPage.completeRedirectCallback", e);
        window.location.replace("/");
      });
  }, []);

  return (
    <div className="grid h-full place-items-center bg-slate-50 p-6 text-center">
      {error ? (
        <div className="w-full max-w-md rounded-2xl border border-[var(--lfb-border)] bg-white p-8 shadow-sm">
          <h1 className="text-lg font-semibold" style={{ color: "var(--lfb-primary)" }}>
            Sign-in didn’t complete
          </h1>
          <p className="mb-6 mt-2 text-sm text-black/60">{error}</p>
          <a href="/" className="inline-block rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-white">
            Back to sign in
          </a>
        </div>
      ) : (
        <div className="text-black/40">Completing sign-in…</div>
      )}
    </div>
  );
}
