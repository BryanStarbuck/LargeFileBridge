// Code-based TanStack Router (sister convention). Auth gating happens in main.tsx (outside the tree).
// Each page component is code-split via lazyRouteComponent (performance.mdx P-10), so first paint only
// downloads the AppShell + the landing route's JS — not every table and the media viewer up front.
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet } from "@tanstack/react-router";
import { AppShell } from "./pages/app/AppShell.js";

// The File System browser and both entity pages take an optional absolute `path` search param
// (menus.mdx §2 cell navigation → files.mdx / directories.mdx / directory.mdx).
const pathSearch = (search: Record<string, unknown>): { path?: string } => ({
  path: typeof search.path === "string" ? search.path : undefined,
});

const rootRoute = createRootRoute({ component: () => <Outlet /> });

// AppShell stays eager — it's the always-present layout (sidebar + scan bar) that hosts every route.
const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
});

const reposRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/",
  component: lazyRouteComponent(() => import("./pages/repos/ReposPage.js"), "ReposPage"),
});
const repoSettingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/repos/$repoId/settings",
  component: lazyRouteComponent(() => import("./pages/repos/RepoSettingsPage.js"), "RepoSettingsPage"),
});
const oneRepoRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/repos/$repoId",
  component: lazyRouteComponent(() => import("./pages/repos/OneRepoPage.js"), "OneRepoPage"),
});
const devicesRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/devices",
  component: lazyRouteComponent(() => import("./pages/devices/DevicesPage.js"), "DevicesPage"),
});
// Storages (storages.mdx): the map of every storage you belong to, and one storage's detail.
const storagesRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/storages",
  component: lazyRouteComponent(() => import("./pages/storages/StoragesPage.js"), "StoragesPage"),
});
// Per-storage settings (storage_settings.mdx): keep .lfbridge/ + where, and the backing locations.
const storageSettingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/storages/$storageId/settings",
  component: lazyRouteComponent(() => import("./pages/storages/StorageSettingsPage.js"), "StorageSettingsPage"),
});
const storageDetailRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/storages/$storageId",
  component: lazyRouteComponent(() => import("./pages/storages/StorageDetailPage.js"), "StorageDetailPage"),
});
// Communities (communities.mdx): discover/subscribe to public-file publishers, a budget meter + table.
const communitiesRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/communities",
  component: lazyRouteComponent(() => import("./pages/communities/CommunitiesPage.js"), "CommunitiesPage"),
});
// The IPFS dashboard / node control panel (ipfs_ui.mdx): install, on/off, metrics, gateway, security.
const ipfsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/ipfs",
  component: lazyRouteComponent(() => import("./pages/ipfs/IpfsDashboardPage.js"), "IpfsDashboardPage"),
});
// The pinset table (ipfs.mdx), now at /ipfs/pins — reached from the dashboard's Shared-files tile.
// Optional `?repo=<repoId>` filters the pinset to one pinning repo (ipfs.mdx §2.1).
const ipfsPinsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/ipfs/pins",
  component: lazyRouteComponent(() => import("./pages/ipfs/IpfsPage.js"), "IpfsPage"),
  validateSearch: (search: Record<string, unknown>): { repo?: string } => ({
    repo: typeof search.repo === "string" ? search.repo : undefined,
  }),
});
// The Scans page (left_bar.yaml routes the "Scans" nav item here). The scheduled background jobs are
// "scheduleTasks" in code; the UI calls what they do "scans" — so the route is /scans (scan.mdx §2 naming).
const scansRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/scans",
  component: lazyRouteComponent(() => import("./pages/sync/SyncPage.js"), "SyncPage"),
});
const allowListRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/settings/allow-list",
  component: lazyRouteComponent(() => import("./pages/settings/AllowListPage.js"), "AllowListPage"),
});
const settingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/settings",
  component: lazyRouteComponent(() => import("./pages/settings/SettingsPage.js"), "SettingsPage"),
});
// The install-tools preflight (tools.mdx): CLI tool status + one-click install, reached from Settings.
const toolsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/tools",
  component: lazyRouteComponent(() => import("./pages/settings/ToolsPage.js"), "ToolsPage"),
});
const fsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/fs",
  component: lazyRouteComponent(() => import("./pages/fs/FileSystemPage.js")), // default export
  validateSearch: pathSearch,
});
// Full paths — the flat large-file table tab under File System (full_paths.mdx).
const fsPathsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/fs/paths",
  component: lazyRouteComponent(() => import("./pages/fs/FullPathsPage.js"), "FullPathsPage"),
  validateSearch: pathSearch,
});
const viewFileRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/file",
  component: lazyRouteComponent(() => import("./pages/entity/ViewOneFilePage.js"), "ViewOneFilePage"),
  validateSearch: pathSearch,
});
const viewDirRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/dir",
  component: lazyRouteComponent(() => import("./pages/entity/ViewOneDirectoryPage.js"), "ViewOneDirectoryPage"),
  validateSearch: pathSearch,
});
// Viewer-first media pages (media_viewer.mdx): /image + /video.
const viewImageRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/image",
  component: lazyRouteComponent(() => import("./pages/entity/ViewOneImagePage.js"), "ViewOneImagePage"),
  validateSearch: pathSearch,
});
const viewVideoRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/video",
  component: lazyRouteComponent(() => import("./pages/entity/ViewOneVideoPage.js"), "ViewOneVideoPage"),
  validateSearch: pathSearch,
});
// The audio player (media_viewer.mdx): /audio — same MediaViewer shell, an <audio controls> centerpiece.
const viewAudioRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/audio",
  component: lazyRouteComponent(() => import("./pages/entity/ViewOneAudioPage.js"), "ViewOneAudioPage"),
  validateSearch: pathSearch,
});

const routeTree = rootRoute.addChildren([
  appLayout.addChildren([
    reposRoute,
    repoSettingsRoute,
    oneRepoRoute,
    devicesRoute,
    storagesRoute,
    storageSettingsRoute,
    storageDetailRoute,
    communitiesRoute,
    ipfsRoute,
    ipfsPinsRoute,
    scansRoute,
    allowListRoute,
    settingsRoute,
    toolsRoute,
    fsRoute,
    fsPathsRoute,
    viewFileRoute,
    viewDirRoute,
    viewImageRoute,
    viewVideoRoute,
    viewAudioRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
