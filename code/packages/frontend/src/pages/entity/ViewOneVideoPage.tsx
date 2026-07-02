// View one video (/video?path=<abs>) — the video viewer (media_viewer.mdx). Thin wrapper over the
// shared MediaViewer; the "video" kind selects the <video controls> surface (streamed with Range).
import { MediaViewer } from "./MediaViewer";

export function ViewOneVideoPage() {
  return <MediaViewer kind="video" />;
}

export { ViewOneVideoPage as default };
