// The app frame: the one left bar + the routed content column (repos.mdx §2 layout).
import { Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { CurrentUser } from "@lfb/shared";
import { api } from "../../api/client.js";
import { Sidebar } from "../../components/layout/Sidebar.js";
import { ScanProgressBar } from "../../components/ScanProgressBar.js";
import { IpfsStatusBanner } from "../../components/IpfsStatusBanner.js";

const FALLBACK: CurrentUser = {
  authenticated: false,
  email: null,
  name: null,
  roles: [],
  permissions: [],
  allowListed: false,
};

export function AppShell() {
  const { data: user } = useQuery({ queryKey: ["me"], queryFn: api.me });
  return (
    <div className="flex h-full">
      <Sidebar user={user ?? FALLBACK} />
      <main className="flex-1 overflow-y-auto">
        <IpfsStatusBanner />
        {/* min-h-full + flex column so a full-page-height table (repos.mdx §3.3.1) can flex its body
            down to the bottom of the viewport; long/normal pages still grow and let <main> scroll. */}
        <div className="mx-auto flex min-h-full max-w-6xl flex-col px-8 py-6">
          <Outlet />
        </div>
      </main>
      <ScanProgressBar />
    </div>
  );
}
