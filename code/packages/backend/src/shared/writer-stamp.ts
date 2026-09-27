// WRITER PROVENANCE — which build, on which computer, created a shared record (backward_compatibility.md §3).
//
// Every record that travels between computers (a decision event, a deletion record, a deletion receipt) is
// stamped ONCE, at creation, by the code that created it. It is never re-stamped by a later merge or
// re-serialization: a stamp that moved with every rewrite would be churn by construction, and would also
// stop answering the one question it exists for — "which build SAID this?".
//
// Absence is meaningful and deliberately not defaulted: a record with no stamp was written by a build before
// 7, or re-serialized by one (an older build parses with a schema that strips fields it does not know).
import { APP_BUILD } from "@lfb/shared";
import { computerLabel } from "../modules/store-model/config.service.js";

export interface WriterStamp {
  writer_build: number;
  writer_device: string;
}

/** The stamp THIS process puts on a record it creates. Never throws: an unreadable config still has a build. */
export function writerStamp(): WriterStamp {
  let device = "this-computer";
  try {
    device = computerLabel();
  } catch {
    /* config unreadable — the build number alone is still the useful half */
  }
  return { writer_build: APP_BUILD.number, writer_device: device };
}
