// The Subsets review screen (subsets.mdx) — /videos/subsets, the second child under the Videos left-bar
// item. VIDEOS ONLY: pairs/groups where one video's content is a contiguous segment cut out of a longer
// SUPERSET video. Mirrors Duplicates (same 60/40 layout and table rules) with the subsets deltas:
// superset-named group headers, superset row/block first, containment lines. Thin wrapper over
// VideosReviewPage.
import type { SubsetMemberRow } from "@lfb/shared";
import { api } from "../../api/client.js";
import { VideosReviewPage } from "./VideosReviewPage.js";
import { buildSubsetGroups } from "./videoGroups.js";

export function SubsetsPage() {
  return (
    <VideosReviewPage<SubsetMemberRow>
      variant="subsets"
      title="Subsets"
      tableId="videos_subsets"
      scanNoun="subset"
      listKey={["videos", "subsets"]}
      statusKey={["videos", "subsets", "status"]}
      fetchList={api.videosSubsets}
      fetchStatus={api.videosSubsetsStatus}
      startScan={api.videosSubsetsScan}
      buildGroups={buildSubsetGroups}
      // Videos only — no File-type facet on this page; the ⛛ filter carries the mpeg7 · vpdq
      // match-basis facet (subsets.mdx §3).
      withFileTypeFacet={false}
      matchBasisValues={["mpeg7", "vpdq"]}
    />
  );
}
