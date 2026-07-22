// The Duplicates review screen (duplicates.mdx) — /videos/duplicates, the first child under the Videos
// left-bar item. Groups of same-content videos and images (byte-identical or perceptually identical),
// reviewed side-by-side in the shared 60/40 layout. Thin wrapper over VideosReviewPage.
import type { DuplicateMemberRow } from "@lfb/shared";
import { api } from "../../api/client.js";
import { VideosReviewPage } from "./VideosReviewPage.js";
import { buildDuplicateGroups } from "./videoGroups.js";

export function DuplicatesPage() {
  return (
    <VideosReviewPage<DuplicateMemberRow>
      variant="duplicates"
      title="Duplicates"
      tableId="videos_duplicates"
      scanNoun="duplicate"
      listKey={["videos", "duplicates"]}
      statusKey={["videos", "duplicates", "status"]}
      fetchList={api.videosDuplicates}
      fetchStatus={api.videosDuplicatesStatus}
      startScan={api.videosDuplicatesScan}
      buildGroups={buildDuplicateGroups}
      // Duplicates covers videos first, images second (videos.mdx §2) — the ⛛ filter carries the
      // File-type facet (duplicates.mdx §3.2).
      withFileTypeFacet
    />
  );
}
