// The per-user prefs, read ONCE per session and shared by every surface (compression_visibility.mdx §1.1).
// Today they carry one flag — `features.compression`, Settings → Compression → "Show compression features",
// default OFF. Every compression entry point outside context menus asks useCompressionEnabled() whether to
// render; the Settings checkbox writes through useSetCompressionEnabled(), which updates the shared cache in
// place so every open surface appears/disappears without a reload.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { UserPrefs } from "@lfb/shared";
import { api } from "./client.js";
import { clientLog } from "../lib/clientLog.js";

export const USER_PREFS_KEY = ["user-prefs"] as const;

export function useUserPrefs() {
  return useQuery({
    queryKey: USER_PREFS_KEY,
    queryFn: api.userPrefs,
    // Only this browser's own Settings checkbox changes it, and that write updates the cache directly.
    staleTime: Infinity,
  });
}

/** True only when the user has turned compression ON. Loading, errors and a missing block all read as OFF —
 *  the default — so a user who never opted in never sees a flash of compression UI (§1.1). */
export function useCompressionEnabled(): boolean {
  const { data } = useUserPrefs();
  return data?.features.compression === true;
}

/** Write the "Show compression features" checkbox. Optimistic: the cache flips on click so the whole app
 *  re-renders at once, then the server's answer replaces it (or the old value comes back on failure). */
export function useSetCompressionEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => api.setUserPrefs({ features: { compression: on } }),
    onMutate: (on: boolean) => {
      const prev = qc.getQueryData<UserPrefs>(USER_PREFS_KEY);
      qc.setQueryData<UserPrefs>(USER_PREFS_KEY, { ...(prev ?? { features: { compression: false } }), features: { ...(prev?.features ?? { compression: false }), compression: on } });
      return { prev };
    },
    onSuccess: (prefs: UserPrefs, on: boolean) => {
      qc.setQueryData(USER_PREFS_KEY, prefs);
      toast.success(on ? "Compression features are now shown" : "Compression features are now hidden");
    },
    onError: (e: Error, _on, ctx) => {
      clientLog.error("useSetCompressionEnabled", e);
      if (ctx?.prev) qc.setQueryData(USER_PREFS_KEY, ctx.prev);
      toast.error(e.message);
    },
  });
}
