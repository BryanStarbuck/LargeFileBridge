// The app frame: the one left bar + the routed content column (repos.mdx §2 layout).
import { useEffect } from "react";
import { Outlet, useRouterState, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { CurrentUser } from "@lfb/shared";
import { api } from "../../api/client.js";
import { Sidebar } from "../../components/layout/Sidebar.js";
import { ScanProgressBar } from "../../components/ScanProgressBar.js";
import { IpfsStatusBanner } from "../../components/IpfsStatusBanner.js";
import { useSessionPing } from "../../lib/useSessionPing.js";
import { useHotkeys } from "../../lib/hotkeys.js";

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
  const navigate = useNavigate();

  // The always-present GLOBAL nav shortcuts (hotkeys.mdx §4). Each fires on the platform modifier
  // (Control on Mac, Alt on Windows/Linux). A page scope registered later wins any key collision.
  useHotkeys("global", "Global", [
    { keys: "r", label: "Go to Repos", run: () => navigate({ to: "/" }) },
    { keys: "f", label: "Go to File System", run: () => navigate({ to: "/fs" }) },
    { keys: "s", label: "Go to Storages", run: () => navigate({ to: "/storages" }) },
    { keys: "d", label: "Go to Devices", run: () => navigate({ to: "/devices" }) },
    { keys: "i", label: "Go to IPFS", run: () => navigate({ to: "/ipfs" }) },
    { keys: "u", label: "Go to Communities", run: () => navigate({ to: "/communities" }) },
    { keys: "n", label: "Go to Scans", run: () => navigate({ to: "/scans" }) },
    { keys: ",", label: "Go to Settings", run: () => navigate({ to: "/settings" }) },
  ]);
  // The media viewer pages (/image, /video, /audio) run FULL-WIDTH so the action bar can use the whole
  // column instead of leaving side gutters (media_viewer.mdx §4.1). The Devices / Peers table also runs
  // full-width so its fixed-width columns get room to breathe (devices.mdx §6). Every other route keeps
  // max-w-6xl.
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Company-mapping review routing (repo_owner_propagation.mdx §4 / AC #4): when a teammate has asserted
  // company ownership over repos this member also has, route the member to the review page BEFORE they land
  // on their normal view — the SECURITY consent gate is never silent. We auto-route once per browser session
  // (sessionStorage latch) so the member isn't trapped if they navigate away; the left-bar badge still
  // reopens it. Nothing is applied without the explicit apply POST on that page.
  const { data: pendingMappings } = useQuery({
    queryKey: ["company-mappings", "pending"],
    queryFn: api.companyMappingsPending,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (!pendingMappings || pendingMappings.length === 0) return;
    if (pathname === "/company-mappings/review") return;
    if (sessionStorage.getItem("lfb.mappingReviewAutoRouted") === "1") return;
    sessionStorage.setItem("lfb.mappingReviewAutoRouted", "1");
    navigate({ to: "/company-mappings/review" });
  }, [pendingMappings, pathname, navigate]);

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
