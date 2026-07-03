import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      // Don't run polling intervals in hidden/background tabs — an idle background tab shouldn't keep
      // hammering the scan-status / sync endpoints (performance.mdx P-07).
      refetchIntervalInBackground: false,
      retry: 1,
    },
  },
});
