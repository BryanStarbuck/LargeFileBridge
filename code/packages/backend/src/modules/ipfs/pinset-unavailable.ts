// pinset-unavailable.ts — the ONE-failure-ONE-WARN marker for a failed `pin ls` (error catalog #17).
// A dependency-free leaf on purpose: pin.service / reconciler must recognise it without importing it through
// ipfs.service.ts, which nearly every pin spec replaces with a partial mock.

/**
 * The pinset could not be read, and the ipfs layer HAS ALREADY SAID SO at WARN.
 *
 * WHY A TYPE. One aborted enumeration used to reach error.err as SIX lines (error catalog #17): this
 * module's WARN, then `pinnedCidSet`, `missingPinnedFromPeers`, the claim verifier, each pin pass and the
 * reconciler each re-announcing the same failure at WARN — because `listPins` is single-flight, every
 * concurrent caller receives the very same rejection. Six WARNs for one event teaches a reader that the
 * count means nothing, which is how a genuinely repeating daemon failure gets missed. The failure is
 * reported ONCE, by ipfs.service `enumeratePins`, where the facts are (elapsed, attempts, stall cap); consumers recognise this type
 * with {@link isPinsetUnavailable} and say what THEY did about it (skipped a pass, kept the claims) at INFO.
 * A failure that is NOT this type — something no one logged yet — keeps its WARN at the consumer.
 */
export class PinsetUnavailableError extends Error {
  readonly reported = true;
  constructor(message: string) {
    super(message);
    this.name = "PinsetUnavailableError";
  }
}

/** Was this the already-reported "pin ls failed" of {@link PinsetUnavailableError}? */
export function isPinsetUnavailable(e: unknown): e is PinsetUnavailableError {
  return e instanceof PinsetUnavailableError || (e as { name?: string })?.name === "PinsetUnavailableError";
}
