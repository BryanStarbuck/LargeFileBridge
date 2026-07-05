// The app frame: the one left bar + the routed content column (repos.mdx §2 layout).
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { CurrentUser } from "@lfb/shared";
import { api } from "../../api/client.js";
import { Sidebar } from "../../components/layout/Sidebar.js";
import { ScanProgressBar } from "../../components/ScanProgressBar.js";
import { IpfsStatusBanner } from "../../components/IpfsStatusBanner.js";
import { useSessionPing } from "../../lib/useSessionPing.js";

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
  useSessionPing(); // record web-session activity on open + each navigation (sessions.mdx)
  // The media viewer pages (/image, /video, /audio) run FULL-WIDTH so the action bar can use the whole
  // column instead of leaving side gutters (media_viewer.mdx §4.1). The Devices / Peers table also runs
  // full-width so its fixed-width columns get room to breathe (devices.mdx §6). Every other route keeps
  // max-w-6xl.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const fullWidth =
    pathname === "/image" ||
    pathname === "/video" ||
    pathname === "/audio" ||
    pathname === "/devices" ||
    pathname.startsWith("/device/");
  return (
    <div className="flex h-full">
      <Sidebar user={user ?? FALLBACK} />
      <main className="flex-1 overflow-y-auto">
        <IpfsStatusBanner />
        {/* min-h-full + flex column so a full-page-height table (repos.mdx §3.3.1) can flex its body
            down to the bottom of the viewport; long/normal pages still grow and let <main> scroll. */}
        <div className={`mx-auto flex min-h-full flex-col px-8 py-6 ${fullWidth ? "max-w-none" : "max-w-6xl"}`}>
          <Outlet />
        </div>
      </main>
      <ScanProgressBar />
    </div>
  );
}
