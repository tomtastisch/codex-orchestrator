import { Store } from "../../dist/db.js";
import { HypothesisRepo } from "../../dist/hypotheses.js";
import { SessionManager } from "../../dist/session.js";
import { LocalExecutionTarget } from "../../dist/execution/local-target.js";
import { systemClock, systemIdGenerator } from "../../dist/system-clock.js";

/** @typedef {import("../../dist/ports/persistence.js").PersistenceStore} PersistenceStore */

/** @param {string} dbPath */
export function createSystemStore(dbPath) {
    return new Store(dbPath, systemClock, systemIdGenerator);
}

/** @param {PersistenceStore} store */
export function createSystemHypothesisRepo(store) {
    return new HypothesisRepo(store, systemClock, systemIdGenerator);
}

/**
 * @param {PersistenceStore} store
 * @param {(id: string) => import("../../dist/execution/types.js").ExecutionTarget} [targetFor]
 */
export function createSystemSessionManager(store, targetFor) {
    const local = new LocalExecutionTarget();
    return new SessionManager(
        store,
        targetFor ?? (() => local),
        systemIdGenerator,
        systemClock,
    );
}
