import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/db.js";

test("v1 task rows migrate to explicit local target provenance", () => {
    const directory = mkdtempSync(join(tmpdir(), "orch-migration-"));
    const path = join(directory, "state.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY, cluster_id TEXT, codex_session_id TEXT,
            worktree TEXT, branch TEXT, repo_path TEXT NOT NULL,
            sandbox TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
            instructions TEXT NOT NULL, acceptance_json TEXT,
            max_minutes INTEGER NOT NULL, network INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL, slice_count INTEGER DEFAULT 0,
            started_at TEXT, ended_at TEXT, last_slice_type TEXT,
            last_summary TEXT, extra_config_json TEXT, owner_pid INTEGER,
            codex_pid INTEGER
        );
        INSERT INTO tasks (
            id, repo_path, sandbox, model, effort, instructions,
            max_minutes, network, status
        ) VALUES ('T_legacy', '/repo', 'read-only', 'model', 'low', 'x', 5, 0, 'queued');
        PRAGMA user_version = 1;
    `);
    legacy.close();

    const store = new Store(path);
    const task = store.getTask("T_legacy");

    assert.equal(task.target_id, "local");
    assert.equal(task.target_kind, "local");
    assert.equal(task.repository_commit, null);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version >= 2, true);
});

test("store permissions are private on POSIX systems", () => {
    const directory = mkdtempSync(join(tmpdir(), "orch-permissions-"));
    const path = join(directory, "nested", "state.sqlite");
    new Store(path);

    if (process.platform !== "win32") {
        assert.equal(statSync(join(directory, "nested")).mode & 0o777, 0o700);
        assert.equal(statSync(path).mode & 0o777, 0o600);
    }
});
