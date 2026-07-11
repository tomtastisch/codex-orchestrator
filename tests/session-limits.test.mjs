import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/db.js";
import { SessionManager } from "../dist/session.js";

test("limit breach closes the task and its open agent job", () => {
    const fixed = "2026-07-11T12:00:00.000Z";
    const clock = { now: () => fixed };
    const ids = { newId: (prefix) => `${prefix}_limit` };
    const store = new Store(
        join(mkdtempSync(join(tmpdir(), "orch-limit-")), "state.sqlite"),
        clock,
        ids,
    );
    const target = { id: "fake", kind: "local" };
    const sessions = new SessionManager(store, () => target, ids, clock);
    const task = sessions.createTask({
        clusterId: null,
        repoPath: "/repo",
        worktree: null,
        branch: null,
        instructions: "test",
        acceptance: [],
        sandbox: "read-only",
        model: "auto",
        effort: "low",
        network: false,
        maxMinutes: 1,
    });
    store.recordAgentJob({
        taskId: task.id,
        clusterId: null,
        hypothesisId: null,
        model: "auto",
        effort: "low",
        sandbox: "read-only",
        status: "queued",
    });

    sessions.limitBreach(task.id, "maxTaskMinutes exceeded");

    assert.deepEqual(
        { status: store.getTask(task.id)?.status, endedAt: store.getTask(task.id)?.ended_at },
        { status: "blocked", endedAt: fixed },
    );
    const job = store.listAgentJobs({ taskId: task.id }).at(-1);
    assert.equal(job.status, "blocked");
    assert.equal(job.ended_at, fixed);
    assert.equal(job.summary, "maxTaskMinutes exceeded");
    assert.deepEqual(
        store.eventsAfter(task.id, 0).map((event) => event.kind),
        ["limit_breach", "task_status"],
    );
});
