// Hand a local file/folder to the host operating system's DEFAULT handler (os_open.mdx). This is the
// "Open on Mac / on PC / on Linux" action on the media viewer + File System pages: the web front end
// asks the (localhost) backend to run the OS open verb (`open` on macOS, `start` on Windows, `xdg-open`
// on Linux) so the file opens in whatever native app is registered for its type — Preview/QuickTime,
// the default image viewer, VLC, Finder/Explorer for a folder, and so on.
//
// Guardrails (os_open.mdx §3):
//   * LOCALHOST ONLY. This is only meaningful when the browser and the backend share one machine. It is
//     refused unless the backend runs in `local` mode AND the request arrived on loopback. A hosted
//     server must never spawn a desktop app for a remote visitor.
//   * CONFINED. The path is confined to the same allow-roots as every other filesystem route
//     (assertAllowedPath) and the secret-stash denylist still applies — we never `open` ~/.ssh, etc.
//   * NON-BLOCKING + DETACHED. The child is spawned detached and unref()'d so a long-lived GUI app never
//     ties up the Node event loop or the HTTP request.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import type { PlatformInfo, OsOpenResult } from "@lfb/shared";
import { getAppConfig } from "../store-model/config.service.js";
import { assertAllowedPath } from "./allow-root.js";
import { expandHome } from "./badges.js";
import { log } from "../../shared/logging.js";

/** The OS family + the human label the "Open on {label}" button shows (os_open.mdx §2). */
export function platformFamily(): { os: PlatformInfo["os"]; label: string } {
  switch (os.platform()) {
    case "darwin":
      return { os: "mac", label: "Mac" };
    case "win32":
      return { os: "windows", label: "PC" };
    case "linux":
      return { os: "linux", label: "Linux" };
    default:
      return { os: "other", label: "this computer" };
  }
}

/**
 * True only when the OS-open verb is allowed to run: the backend is in `local` mode AND the request came
 * from loopback (os_open.mdx §3). In server mode — or for any non-loopback caller — hand-off is refused
 * so a hosted instance never launches a desktop app for a remote visitor.
 */
export function isLocalRequest(req: Request): boolean {
  if (getAppConfig().server.mode !== "local") return false;
  const ip = req.ip || req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** What the front end needs to render the OS buttons: the label, and whether hand-off is possible here. */
export function platformInfo(req: Request): PlatformInfo {
  const fam = platformFamily();
  return { os: fam.os, label: fam.label, canOpenInOS: isLocalRequest(req) };
}

/** The default-handler open command for this platform (folder or file — the OS decides the app). */
function openCommand(abs: string): { bin: string; args: string[] } {
  switch (os.platform()) {
    case "darwin":
      return { bin: "open", args: [abs] };
    case "win32":
      // `start` is a cmd builtin; the empty "" is the window title arg so a quoted path isn't taken as one.
      return { bin: "cmd", args: ["/c", "start", "", abs] };
    default:
      return { bin: "xdg-open", args: [abs] };
  }
}

/**
 * Open `input` (an absolute file OR directory path) in the host OS default handler. Confined + localhost-
 * gated. Returns which path was opened and whether it was a directory. Throws a clear reason otherwise.
 */
export function openInOs(req: Request, input: string | undefined): OsOpenResult {
  if (!isLocalRequest(req)) {
    throw new Error("Opening in the desktop OS is only available on localhost");
  }
  if (!input || !input.trim()) throw new Error("path required");
  const abs = assertAllowedPath(path.resolve(expandHome(input.trim())));
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error("file not found");
  }
  const { bin, args } = openCommand(abs);
  try {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => log.warn("fs", `os-open ${abs} failed: ${(e as Error).message}`));
    child.unref();
  } catch (e) {
    throw new Error(`could not hand off to the OS: ${(e as Error).message}`);
  }
  log.info("fs", `os-open ${abs} (${st.isDirectory() ? "dir" : "file"}) via ${bin}`);
  return { opened: true, path: abs, isDir: st.isDirectory(), via: platformFamily().label };
}
