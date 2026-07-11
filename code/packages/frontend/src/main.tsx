import { StrictMode, type CSSProperties } from "react";
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
import { ProgressProvider } from "./progress/ProgressContext.js";
import { ProgressDock } from "./components/ProgressDock.js";
import { FirstTimeStorageWizardProvider } from "./components/FirstTimeStorageWizard.js";
import { CompressInsideProvider } from "./components/compress/CompressInsideProvider.js";
import { GitIgnoreProvider } from "./components/gitignore/GitIgnoreProvider.js";
import { HoverInfoProvider } from "./components/hoverinfo/HoverInfoContext.js";
import { HotkeyProvider } from "./lib/hotkeys.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { leftBar } from "./config/left_bar.js";
import { clientLog } from "./lib/clientLog.js";
import "./styles.css";

// The bottom-left offset that clears the left bar for BOTH the toast stack and the progress dock
// (webapp.mdx §9/§10). 256px bar + 16px gutter, tracked from the yaml-driven width so a bar-width
// change in config/left_bar.ts moves both surfaces together.
const BAR_CLEAR_LEFT = `calc(${leftBar.sidebarWidth} + 16px)`;

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
  // Signed-in app: the progress dock overlays every screen and shares one active-job set with the
  // pages' optimistic run() (webapp.mdx §10/§12). Both live inside QueryClientProvider (from the mount).
  return (
    <ProgressProvider>
      {/* Global keyboard shortcuts + the "?" help overlay (hotkeys.mdx). Inside the router so page
          scopes can register/unregister as routes mount. */}
      <HotkeyProvider>
        {/* Non-intrusive hover-info state (non_intrusive_tooltip.mdx §4): wraps the app so BOTH the panel in
            the Sidebar and the lists (badge chips + FS rows) share the one active-hover payload. */}
        <HoverInfoProvider>
          <RouterProvider router={router} />
        </HoverInfoProvider>
        <ProgressDock />
        {/* First-time setup wizard (Transcribe.mdx §3.5): opens when a Transcribe / Get-AI-details action
            hits `needs_setup`. Mounted here so it's inside the query + hotkey providers and only for the
            signed-in app. Listens on the setupWizard bus — no per-call-site wiring. */}
        <FirstTimeStorageWizardProvider />
        {/* The "Compress videos & images inside" pop-over dialog (compress_inside.mdx §2): opens when a
            directory ⋮ "Compress …inside" item or a page "Compress all…" link fires openCompressInside. */}
        <CompressInsideProvider />
        {/* The "Git ignore" pop-over dialog (git_ignore.mdx §4): opens when a page "Git ignore" link or a
            file/dir/repo ⋮ item fires openGitIgnore. */}
        <GitIgnoreProvider />
      </HotkeyProvider>
    </ProgressProvider>
  );
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
        {/* Stable host wrapper. Without it the top-level tree mounted straight onto the raw #root
            container, so every auth-gate swap (Loading ↔ App ↔ SignIn) and every churning overlay
            (ProgressDock, the wizard/compress dialog providers — all direct container children since the
            providers between them and #root are context-only) inserted/removed via
            insertInContainerBefore / removeChildFromContainer. That is the operation that was throwing
            "Failed to execute 'insertBefore'/'removeChild' … not a child of this node" in the commit
            phase (687× in the fault trail, July 5–9) and — with no error boundary — blanking the whole
            SPA. A persistent <div> gives React a real parent so those swaps use plain insertBefore on a
            stable node. h-full keeps AppShell's `flex h-full` height chain intact (html/body/#root are
            height:100% in styles.css). */}
        <div className="h-full">
          {/* Catch a stray render/commit throw and show a recoverable card instead of a dead white page. */}
          <ErrorBoundary>{isSsoCallback ? <SsoCallbackPage /> : <Root />}</ErrorBoundary>
          {/* Toasts: bottom-left, ~2× larger, offset clear of the 256px left bar (webapp.mdx §9). The
              inline `left` (from the yaml-driven bar width) overrides sonner's stylesheet position so the
              stack never sits over the nav; --width enlarges the card and text-base/roomier padding give
              it ~2× visual weight. The progress dock (bottom: 88px) stacks above this toast row
              (bottom: 16px) so the two never collide. */}
          <Toaster
            position="bottom-left"
            richColors
            style={{ "--width": "440px", left: BAR_CLEAR_LEFT } as CSSProperties}
            toastOptions={{ className: "text-base", style: { padding: "14px 16px" } }}
          />
        </div>
      </QueryClientProvider>
    </StrictMode>,
  );
} catch (e) {
  clientLog.fatal("main.render", e);
  throw e;
}
