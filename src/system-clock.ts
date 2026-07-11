import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "./ports/clock.js";

// Infrastructure adapters for the Clock and IdGenerator ports (src/ports/clock.ts).
// These are the process-wide default implementations backed by the system clock
// and the platform CSPRNG. They deliberately live outside the persistence
// adapter (src/db.ts) so domain/application modules can depend on time and
// identity without importing the concrete SQLite store.

/** Current instant as an ISO-8601 timestamp. */
export function nowIso(): string {
    return new Date().toISOString();
}

/** Prefix-tagged identifier derived from a UUIDv4 (e.g. "P_1a2b3c4d5e6f"). */
export function newId(prefix: string): string {
    return `${prefix}_${randomUUID().slice(0, 12)}`;
}

/** Default Clock adapter backed by the system wall clock. */
export const systemClock: Clock = { now: nowIso };

/** Default IdGenerator adapter backed by the platform CSPRNG. */
export const systemIdGenerator: IdGenerator = { newId };
