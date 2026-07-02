// View one image (/image?path=<abs>) — the image viewer (media_viewer.mdx). Thin wrapper over the
// shared MediaViewer; the "image" kind selects the <img> surface.
import { MediaViewer } from "./MediaViewer";

export function ViewOneImagePage() {
  return <MediaViewer kind="image" />;
}

export { ViewOneImagePage as default };
