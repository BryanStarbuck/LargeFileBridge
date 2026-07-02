// Code-based TanStack Router (sister convention). Auth gating happens in main.tsx (outside the tree).
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { AppShell } from "./pages/app/AppShell.js";
import { ReposPage } from "./pages/repos/ReposPage.js";
import { OneRepoPage } from "./pages/repos/OneRepoPage.js";
import { RepoSettingsPage } from "./pages/repos/RepoSettingsPage.js";
import { PeersPage } from "./pages/peers/PeersPage.js";
import { SyncPage } from "./pages/sync/SyncPage.js";
import { SettingsPage } from "./pages/settings/SettingsPage.js";
import { AllowListPage } from "./pages/settings/AllowListPage.js";
import FileSystemPage from "./pages/fs/FileSystemPage.js";
import { FullPathsPage } from "./pages/fs/FullPathsPage.js";
import { ViewOneFilePage } from "./pages/entity/ViewOneFilePage.js";
import { ViewOneDirectoryPage } from "./pages/entity/ViewOneDirectoryPage.js";
import { IpfsPage } from "./pages/ipfs/IpfsPage.js";
import { ViewOneImagePage } from "./pages/entity/ViewOneImagePage.js";
import { ViewOneVideoPage } from "./pages/entity/ViewOneVideoPage.js";

// The File System browser and both entity pages take an optional absolute `path` search param
// (menus.mdx §2 cell navigation → files.mdx / directories.mdx / directory.mdx).
const pathSearch = (search: Record<string, unknown>): { path?: string } => ({
  path: typeof search.path === "string" ? search.path : undefined,
});

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const appLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
});

const reposRoute = createRoute({ getParentRoute: () => appLayout, path: "/", component: ReposPage });
const repoSettingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/repos/$repoId/settings",
  component: RepoSettingsPage,
});
const oneRepoRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/repos/$repoId",
  component: OneRepoPage,
});
const peersRoute = createRoute({ getParentRoute: () => appLayout, path: "/peers", component: PeersPage });
// The IPFS page (ipfs.mdx). Optional `?repo=<repoId>` filters the pinset to one pinning repo (§2.1).
const ipfsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/ipfs",
  component: IpfsPage,
  validateSearch: (search: Record<string, unknown>): { repo?: string } => ({
    repo: typeof search.repo === "string" ? search.repo : undefined,
  }),
});
const syncRoute = createRoute({ getParentRoute: () => appLayout, path: "/sync", component: SyncPage });
const allowListRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/settings/allow-list",
  component: AllowListPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/settings",
  component: SettingsPage,
});
const fsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/fs",
  component: FileSystemPage,
  validateSearch: pathSearch,
});
// Full paths — the flat large-file table tab under File System (full_paths.mdx).
const fsPathsRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/fs/paths",
  component: FullPathsPage,
  validateSearch: pathSearch,
});
const viewFileRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/file",
  component: ViewOneFilePage,
  validateSearch: pathSearch,
});
const viewDirRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/dir",
  component: ViewOneDirectoryPage,
  validateSearch: pathSearch,
});
// Viewer-first media pages (media_viewer.mdx): /image + /video.
const viewImageRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/image",
  component: ViewOneImagePage,
  validateSearch: pathSearch,
});
const viewVideoRoute = createRoute({
  getParentRoute: () => appLayout,
  path: "/video",
  component: ViewOneVideoPage,
  validateSearch: pathSearch,
});

const routeTree = rootRoute.addChildren([
  appLayout.addChildren([
    reposRoute,
    repoSettingsRoute,
    oneRepoRoute,
    peersRoute,
    ipfsRoute,
    syncRoute,
    allowListRoute,
    settingsRoute,
    fsRoute,
    fsPathsRoute,
    viewFileRoute,
    viewDirRoute,
    viewImageRoute,
    viewVideoRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
