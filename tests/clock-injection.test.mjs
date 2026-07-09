import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/db.js";
import { HypothesisRepo } from "../dist/hypotheses.js";

// Proves the Clock/IdGenerator ports are a real seam, not decoration: injecting
// deterministic implementations makes time and identity fully controllable —
// the whole point of the ports. If the adapters ever revert to ambient
// nowIso/newId, these assertions fail.

function freshStore(clock, ids) {
    return new Store(join(mkdtempSync(join(tmpdir(), "orch-clk-")), "s.sqlite"), clock, ids);
}

test("Store reads time and identity from the injected ports", () => {
    const fixed = "2020-01-01T00:00:00.000Z";
    let n = 0;
    const store = freshStore({ now: () => fixed }, { newId: (prefix) => `${prefix}_fixed${n++}` });

    const plan = store.createPlan("goal", null, "/repo");
    assert.equal(plan.created_at, fixed, "created_at must come from the injected Clock");
    assert.match(plan.id, /^P_fixed\d+$/, "id must come from the injected IdGenerator");
});

test("HypothesisRepo reads time and identity from the injected ports", () => {
    const fixed = "2021-06-15T12:00:00.000Z";
    let n = 0;
    const clock = { now: () => fixed };
    const ids = { newId: (prefix) => `${prefix}_fixed${n++}` };
    const repo = new HypothesisRepo(freshStore(clock, ids), clock, ids);

    const h = repo.create({ initialAssumption: "assumption", confidenceBefore: 0.5 });
    assert.equal(h.createdAt, fixed, "createdAt must come from the injected Clock");
    assert.equal(h.updatedAt, fixed);
    assert.match(h.id, /^H_fixed\d+$/, "id must come from the injected IdGenerator");
});
