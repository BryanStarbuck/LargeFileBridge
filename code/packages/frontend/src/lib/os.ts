// Desktop OS hand-off launcher (os_open.mdx). Wraps api.osOpen in a toast so "Open on Mac / on PC /
// on Linux" shows a spinner then an honest result. Localhost-only on the backend; the button is hidden
// when platform.canOpenInOS is false, so this is only ever called when hand-off is possible.
import { toast } from "sonner";
import { api } from "@/api/client";
import { clientLog } from "./clientLog.js";

/** Open a local file OR folder in the host OS default handler ("Open on {label}"). */
export function runOsOpen(path: string, name: string): void {
  toast.promise(api.osOpen(path), {
    loading: `Opening ${name} in the desktop app…`,
    success: (r) => `Opened ${r.isDir ? "folder" : "file"} on ${r.via}`,
    error: (e) => {
      clientLog.error("os.open", e);
      return e instanceof Error ? e.message : "Could not open in the desktop OS";
    },
  });
}
