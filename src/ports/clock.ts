// Time and identity ports.
//
// Reading the wall clock or generating identifiers are ambient side effects that
// make behaviour non-deterministic and hard to test. The `Store`,
// `HypothesisRepo` and `SessionManager` depend on these narrow ports instead;
// the concrete implementations live in the infrastructure layer
// (`src/system-clock.ts`, `systemClock`/`systemIdGenerator`), and the
// composition root (`src/app/context.ts`) injects them. Constructors default to
// the system adapters, so tests can substitute deterministic implementations.

/** Supplies the current instant as an ISO-8601 timestamp. */
export interface Clock {
    now(): string;
}

/** Mints opaque, prefix-tagged, collision-resistant identifiers. */
export interface IdGenerator {
    newId(prefix: string): string;
}
