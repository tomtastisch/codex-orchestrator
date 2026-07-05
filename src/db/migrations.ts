import type { DatabaseSync } from "node:sqlite";

const TASK_COLUMNS: ReadonlyArray<readonly [string, string]> = [
    ["target_id", "TEXT NOT NULL DEFAULT 'local'"],
    ["target_kind", "TEXT NOT NULL DEFAULT 'local'"],
    ["repository_commit", "TEXT"],
    ["worker_version", "TEXT"],
    ["routing_reason", "TEXT"],
    ["fallback_from", "TEXT"],
];

export const CURRENT_SCHEMA_VERSION = 2;

/** Applies idempotent schema migrations inside one immediate transaction. */
export function runMigrations(db: DatabaseSync): void {
    const existing = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name),
    );

    db.exec("BEGIN IMMEDIATE");
    try {
        for (const [name, definition] of TASK_COLUMNS) {
            if (!existing.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
        }
        db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}
