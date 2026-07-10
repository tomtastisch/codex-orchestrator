import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, SCHEMA_VERSION } from "../dist/db.js";
import { CURRENT_SCHEMA_VERSION } from "../dist/db/migrations.js";

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

test("both migration runners reach their terminal version and stay idempotent", () => {
    // The Store runs two independent migration runners with two independent
    // markers: db/migrations.ts (PRAGMA user_version -> CURRENT_SCHEMA_VERSION,
    // task routing columns) and Store.runMigrations (meta.schema_version ->
    // SCHEMA_VERSION, hypothesis/agent-job schema). Pin BOTH terminal markers so
    // a future bump to one runner without the other (silent drift) fails here,
    // and prove reopening the same DB is a no-op (idempotent).
    const path = join(mkdtempSync(join(tmpdir(), "orch-migsync-")), "state.sqlite");

    const first = new Store(path);
    assert.equal(first.db.prepare("PRAGMA user_version").get().user_version, CURRENT_SCHEMA_VERSION);
    assert.equal(first.getSchemaVersion(), SCHEMA_VERSION);
    first.db.close();

    // Second open re-runs both runners against an already-current DB: no throw,
    // markers unchanged.
    const reopened = new Store(path);
    assert.equal(reopened.db.prepare("PRAGMA user_version").get().user_version, CURRENT_SCHEMA_VERSION);
    assert.equal(reopened.getSchemaVersion(), SCHEMA_VERSION);
    reopened.db.close();
});

test("a legacy hypotheses table upgrades to the full versioned header shape", () => {
    const path = join(mkdtempSync(join(tmpdir(), "orch-hyp-legacy-")), "state.sqlite");
    const legacy = new DatabaseSync(path);
    // Pre-versioning hypotheses table: none of the header columns exist yet.
    legacy.exec(`
        CREATE TABLE hypotheses (
            id TEXT PRIMARY KEY, plan_id TEXT, text TEXT,
            status TEXT, evidence TEXT, updated_at TEXT
        );
        INSERT INTO hypotheses (id, plan_id, text, status, updated_at)
        VALUES ('H_legacy', 'P_1', 'assumption', 'open', '2020-01-01T00:00:00.000Z');
        PRAGMA user_version = 1;
    `);
    legacy.close();

    const store = new Store(path);
    const columns = new Set(
        store.db.prepare("PRAGMA table_info(hypotheses)").all().map((c) => c.name),
    );
    for (const required of ["task_id", "cluster_id", "result", "latest_version", "created_at"]) {
        assert.ok(columns.has(required), `migrated hypotheses table missing column: ${required}`);
    }
    // Both markers terminal, and the migrated store reads the legacy row's header.
    assert.equal(store.getSchemaVersion(), SCHEMA_VERSION);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, CURRENT_SCHEMA_VERSION);
    assert.ok(store.listHypothesisHeaders().some((h) => h.id === "H_legacy"));
    store.db.close();
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
