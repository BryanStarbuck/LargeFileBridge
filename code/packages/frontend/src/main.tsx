import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { queryClient } from "./api/queryClient.js";
import { router } from "./router.js";
import { api } from "./api/client.js";
import { SignInPage } from "./pages/sign-in/SignInPage.js";
import "./styles.css";

// Auth gate (charter: no anonymous account). In localhost dev the backend authenticates the dev
// user, so /auth/me returns authenticated and the app renders without a sign-in round-trip.
function Root() {
  const { data: me, isLoading } = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  if (isLoading) return <div className="grid h-full place-items-center text-black/40">Loading…</div>;
  if (!me?.authenticated || !me.allowListed) return <SignInPage />;
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
      <Toaster position="bottom-right" richColors />
    </QueryClientProvider>
  </StrictMode>,
);
