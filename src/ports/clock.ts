// Time and identity ports.
//
// The domain and application layers must not read the wall clock or generate
// identifiers themselves — those are ambient side effects that make behaviour
// non-deterministic and hard to test. They depend on these narrow ports; the
// concrete implementations live in the infrastructure layer (see
// `src/system-clock.ts`), and a composition root injects them.

/** Supplies the current instant as an ISO-8601 timestamp. */
export interface Clock {
    now(): string;
}

/** Mints opaque, prefix-tagged, collision-resistant identifiers. */
export interface IdGenerator {
    newId(prefix: string): string;
}
