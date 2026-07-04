import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { queryClient } from "./api/queryClient.js";
import { router } from "./router.js";
import { api } from "./api/client.js";
import { authCore } from "./api/authCore.js";
import { SignInPage } from "./pages/sign-in/SignInPage.js";
import { SsoCallbackPage } from "./pages/sign-in/SsoCallbackPage.js";
import { SecuritySetupPage } from "./pages/security/SecuritySetupPage.js";
import { clientLog } from "./lib/clientLog.js";
import "./styles.css";

// Catch-all fault trail: anything that escapes a component (a thrown render, an un-.catch()'d promise)
// still reaches error.err via the client-log bridge instead of dying silently in the devtools console.
window.addEventListener("error", (e) => {
  clientLog.error("window.error", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  clientLog.error("window.unhandledrejection", e.reason);
});

// Boot gate order (security.mdx §3): 1) first-run Security Setup (who may sign in — unauthenticated),
// 2) sign-in (SignInPage handles the Google-creds-missing card), 3) allow-listed → the app.
function Root() {
  // Rehydrate the session from the cookie so getToken() can mint a Bearer for /auth/me and every
  // other /api call. Without this a completed Google login still reads as unauthenticated.
  const { data: authReady } = useQuery({
    queryKey: ["authInit"],
    queryFn: async () => {
      await authCore.load();
      return true;
    },
    retry: false,
  });

  const { data: sec, isLoading: secLoading } = useQuery({
    queryKey: ["securityConfig"],
    queryFn: api.securityConfig,
    retry: false,
  });
  // Only ask "who am I" once the install's allow-list exists AND the session is rehydrated.
  const { data: me, isLoading: meLoading } = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
    enabled: sec?.configured === true && authReady === true,
  });

  if (secLoading) return <div className="grid h-full place-items-center text-black/40">Loading…</div>;
  if (sec && !sec.configured) return <SecuritySetupPage config={sec} />;

  if (!authReady || meLoading)
    return <div className="grid h-full place-items-center text-black/40">Loading…</div>;
  if (!me?.authenticated || !me.allowListed) return <SignInPage />;
  return <RouterProvider router={router} />;
}

// The OpenAuthFederated redirect lands on /sso-callback first; finish that handshake outside the
// auth gate (the user isn't "authenticated" per /auth/me yet). Branch here — not inside Root — so
// Root's hooks always run in the same order (Rules of Hooks).
const isSsoCallback = window.location.pathname === "/sso-callback";

// Wrap the initial mount: a failure here (missing #root, a throw during the first render) would leave
// a blank page with nothing in the fault trail — log it (fatal: the app never came up) then rethrow.
try {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        {isSsoCallback ? <SsoCallbackPage /> : <Root />}
        <Toaster position="bottom-right" richColors />
      </QueryClientProvider>
    </StrictMode>,
  );
} catch (e) {
  clientLog.fatal("main.render", e);
  throw e;
}
