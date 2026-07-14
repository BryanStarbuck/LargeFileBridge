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
import { TranscribeModelConsentProvider } from "./components/TranscribeModelConsentDialog.js";
import { CompressInsideProvider } from "./components/compress/CompressInsideProvider.js";
import { GitIgnoreProvider } from "./components/gitignore/GitIgnoreProvider.js";
import { ModalHost } from "./components/ui/ModalHost.js";
import { BatchPopupHost } from "./components/ui/BatchPopupHost.js";
import { HoverInfoProvider } from "./components/hoverinfo/HoverInfoContext.js";
import { HotkeyProvider } from "./lib/hotkeys.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { leftBar } from "./config/left_bar.js";
import { clientLog, errMessage } from "./lib/clientLog.js";
import "./styles.css";

// The bottom-left offset that clears the left bar for BOTH the toast stack and the progress dock
// (webapp.mdx §9/§10). 256px bar + 16px gutter, tracked from the yaml-driven width so a bar-width
// change in config/left_bar.ts moves both surfaces together.
const BAR_CLEAR_LEFT = `calc(${leftBar.sidebarWidth} + 16px)`;

// Some browser TRANSLATION tools (Google Translate / Chrome auto-translate) swap React-managed text
// nodes out from under the reconciler. React's next commit then calls removeChild/insertBefore on a
// node that is no longer where it expects it and throws a NotFoundError with a PURE React-internal
// stack (zero app frames). We opt the document out of translation in index.html (html translate="no"
// + notranslate), but a user's extension can still force it — so treat THIS specific signature as a
// known, non-fatal event: log it at WARN (not ERROR) and rate-limit it so it can't flood error.err
// the way it did before (~700 entries). Everything else keeps flowing to the fault trail at ERROR.
function isTranslationDomError(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : String((err as { message?: unknown })?.message ?? "");
  const isNotFound = name === "NotFoundError" || /NotFoundError/.test(msg);
  return isNotFound && /removeChild|insertBefore/.test(msg) && /not a child of this node/.test(msg);
}

// Axios raises a plain "Network Error" (or ECONNABORTED/ERR_CANCELED) whenever a request can't
// complete for a reason that isn't an app bug: the backend is mid-restart (`just run` reload, an
// IPFS daemon (re)install bouncing the API), a request got aborted by navigation/unmount, or the
// dev server itself is cycling. None of those are exceptions in OUR code, but every one of them
// surfaces as an unhandled promise rejection wherever a query/call site doesn't attach onError. A
// request that DID reach the backend and got a real HTTP response (4xx/5xx) is a genuine failure —
// only the no-response/aborted shape is treated as transient here.
function isTransientNetworkError(err: unknown): boolean {
  const e = err as { isAxiosError?: boolean; code?: string; message?: string; response?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  const isAxios = e.isAxiosError === true || (err instanceof Error && err.name === "AxiosError");
  if (!isAxios || e.response) return false;
  const transientCodes = new Set(["ERR_NETWORK", "ECONNABORTED", "ERR_CANCELED"]);
  return (e.code !== undefined && transientCodes.has(e.code)) || e.message === "Network Error";
}

// Rate-limit: log the 1st occurrence and then every Nth, so the signal stays visible without spam.
let translationDomHits = 0;
let networkErrorHits = 0;
function reportGlobal(context: string, err: unknown): void {
  if (isTranslationDomError(err)) {
    translationDomHits += 1;
    if (translationDomHits === 1 || translationDomHits % 100 === 0) {
      clientLog.warn(context, `[translation-extension DOM mutation, non-fatal, x${translationDomHits}] ${errMessage(err)}`);
    }
    return;
  }
  if (isTransientNetworkError(err)) {
    networkErrorHits += 1;
    if (networkErrorHits === 1 || networkErrorHits % 20 === 0) {
      clientLog.warn(context, `[transient network error, non-fatal, x${networkErrorHits}] ${errMessage(err)}`);
    }
    return;
  }
  clientLog.error(context, err);
}

// Catch-all fault trail: anything that escapes a component (a thrown render, an un-.catch()'d promise)
// still reaches error.err via the client-log bridge instead of dying silently in the devtools console.
window.addEventListener("error", (e) => {
  reportGlobal("window.error", e.error ?? e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  reportGlobal("window.unhandledrejection", e.reason);
});

// A centered full-height status card — the three non-app boot states (Loading / Reconnecting / a
// hard boot error) all render through this so they look like one system (authentication.mdx §6).
function BootStatus({ label, detail, onRetry }: { label: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="grid h-full place-items-center bg-slate-50 text-center">
      <div className="max-w-sm px-6">
        <div className="text-sm font-medium text-black/60">{label}</div>
        {detail && <div className="mt-1 text-xs text-black/40">{detail}</div>}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-md bg-[var(--lfb-primary)] px-4 py-2 text-sm text-white"
          >
            Retry now
          </button>
        )}
      </div>
    </div>
  );
}

// React-Query retry predicate. Keep retrying WHILE the backend is merely unreachable (a `just run`
// restart, an IPFS-daemon bounce, a brief offline) — but NEVER retry a real HTTP response, which is
// authoritative. This is the heart of the "restart → re-login" fix (authentication.mdx §5): the auth
// probes WAIT for the backend to come back instead of resolving as "signed out" and bouncing a
// still-valid session to the sign-in page. Transient errors therefore never reach `isError` — so an
// `isError` below is always a genuine (non-transient) failure worth surfacing, not a restart blip.
function retryWhileBackendDown(_failureCount: number, error: unknown): boolean {
  return isTransientNetworkError(error);
}

// Boot gate order (security.mdx §3, authentication.mdx §5): 0) backend unreachable → Reconnecting
// (NEVER sign-in); 1) first-run Security Setup (who may sign in); 2) sign-in (SignInPage handles the
// Google-creds-missing card); 3) allow-listed → the app.
function Root() {
  // Rehydrate the session from the cookie so getToken() can mint a Bearer for /auth/me and every
  // other /api call. authCore.load() NEVER throws — it retries a backend-down window internally
  // (~15s) and records the outcome in loadState(): "loaded" is an AUTHORITATIVE answer (signed-in OR
  // signed-out), while "failed"/"degraded" means the backend was unreachable. We surface loadState so
  // the gate shows "Reconnecting…" during a server restart instead of the sign-in page — the fix for
  // the long-standing "when we restart the web server we still have to re-login" bug. The session
  // itself is durable server-side (secret + FileSessionStore), so once the backend is back the cookie
  // rehydrates with no Google round-trip. See authentication.mdx §5.
  const auth = useQuery({
    queryKey: ["authInit"],
    queryFn: async () => {
      await authCore.load();
      return { state: authCore.loadState(), signedIn: authCore.getSnapshot().isSignedIn };
    },
    retry: false,
    // While the backend is unreachable, poll so a restart auto-recovers WITHOUT a re-login.
    refetchInterval: (q) => (q.state.data && q.state.data.state !== "loaded" ? 3000 : false),
  });
  const authLoaded = auth.data?.state === "loaded";
  const backendUnreachable = auth.data != null && auth.data.state !== "loaded";

  const sec = useQuery({
    queryKey: ["securityConfig"],
    queryFn: api.securityConfig,
    retry: retryWhileBackendDown,
  });
  // Only ask "who am I" once the install's allow-list exists AND the session is AUTHORITATIVELY
  // rehydrated (auth "loaded"). Retried while the backend is down, so a transient miss during a
  // restart never reads as signed-out.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: retryWhileBackendDown,
    enabled: sec.data?.configured === true && authLoaded,
  });

  // 0) Backend unreachable (mid-restart / briefly offline): Reconnecting, NEVER the sign-in page.
  //    Transient failures keep the queries in a retrying (pending) state; the authoritative signal is
  //    auth.loadState() going non-"loaded". Poll-driven recovery re-runs everything automatically.
  if (backendUnreachable) {
    return <BootStatus label="Reconnecting to Large File Bridge…" detail="The server is restarting — you stay signed in." />;
  }
  // A genuine (non-transient) failure — a 5xx/parse error the retry predicate refused to swallow.
  // Surface it with a manual retry rather than silently showing the sign-in page.
  if (sec.isError || me.isError) {
    const err = (sec.error ?? me.error) as Error | undefined;
    return (
      <BootStatus
        label="Large File Bridge ran into a problem starting up."
        detail={err?.message}
        onRetry={() => {
          void sec.refetch();
          void me.refetch();
        }}
      />
    );
  }

  if (sec.isPending) return <BootStatus label="Loading…" />;
  if (sec.data && !sec.data.configured) return <SecuritySetupPage config={sec.data} />;

  if (!authLoaded || me.isPending) return <BootStatus label="Loading…" />;
  if (!me.data?.authenticated || !me.data.allowListed) return <SignInPage />;
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
        {/* The heavyweight transcription-model consent popup (transcribe_engine.mdx §3.2): opens the first
            time a user transcribes on Apple Silicon where the Qwen3-ASR model isn't provisioned yet.
            Listens on the model-consent bus (lib/transcribe.ts) — no per-call-site wiring. */}
        <TranscribeModelConsentProvider />
        {/* The "Compress videos & images inside" pop-over dialog (compress_inside.mdx §2): opens when a
            directory ⋮ "Compress …inside" item or a page "Compress all…" link fires openCompressInside. */}
        <CompressInsideProvider />
        {/* The "Git ignore" pop-over dialog (git_ignore.mdx §4): opens when a page "Git ignore" link or a
            file/dir/repo ⋮ item fires openGitIgnore. */}
        <GitIgnoreProvider />
        {/* In-app HTML confirm/prompt modals (dialogs.mdx §2.3): the host any imperative handler reaches via
            confirmModal()/promptModal() — the app NEVER calls window.confirm/alert/prompt. */}
        <ModalHost />
        {/* The unified batch-confirm popup host (dialogs.mdx §5.3): the "great pop-up" the page action-links
            row + the ⋮/right-click "Create Transcriptions"/"Create AI descriptions" items open via
            openTranscribeBatch()/openDescribeBatch(). */}
        <BatchPopupHost />
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
