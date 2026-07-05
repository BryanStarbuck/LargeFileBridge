// View one audio (/audio?path=<abs>) — the audio player (media_viewer.mdx). Thin wrapper over the
// shared MediaViewer; the "audio" kind selects the <audio controls> surface (streamed with Range so
// scrubbing seeks). Audio is not a compressible kind (charter), so the viewer shows no Compress action.
import { MediaViewer } from "./MediaViewer";

export function ViewOneAudioPage() {
  return <MediaViewer kind="audio" />;
}

export { ViewOneAudioPage as default };
