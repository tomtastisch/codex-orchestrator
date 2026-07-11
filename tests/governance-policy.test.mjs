import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Governance SSOT contract (Point 3: orchestrator issue routing).
//
// ssot/governance.json is the single source of truth for WHERE issues about the
// codex-orchestrator itself are filed. CLAUDE.md must carry the same fixed
// destination and the fail-closed routing rule so an operator/orchestrator run
// cannot silently file an orchestrator defect into the target working project.

const gov = JSON.parse(readFileSync("ssot/governance.json", "utf8"));
const claude = readFileSync("CLAUDE.md", "utf8");
const index = readFileSync("ssot/index.toml", "utf8");

test("governance.json pins the orchestrator repository identity", () => {
    const r = gov.orchestratorRepo;
    assert.equal(r.owner, "tomtastisch");
    assert.equal(r.repo, "codex-orchestrator");
    assert.equal(r.url, "https://github.com/tomtastisch/codex-orchestrator");
    assert.equal(r.issuesUrl, "https://github.com/tomtastisch/codex-orchestrator/issues");
});

test("issue routing is fail-closed and forbids the target project", () => {
    const ir = gov.issueRouting;
    assert.equal(ir.policy, "fail-closed");
    assert.equal(ir.mustTarget, "orchestratorRepo");
    assert.equal(ir.targetProjectIssues, "forbidden");
    assert.match(ir.onUncertainty, /orchestratorRepo/);
    // Authorization decision is explicit and machine-readable.
    assert.equal(ir.auth.keyRequired, false);
    assert.equal(ir.auth.publicKey, null);
});

test("CLAUDE.md carries the same fixed destination and the fail-closed rule", () => {
    assert.ok(
        claude.includes(gov.orchestratorRepo.url),
        "CLAUDE.md must state the orchestrator repo URL explicitly",
    );
    assert.ok(
        claude.includes(gov.orchestratorRepo.issuesUrl),
        "CLAUDE.md must state the orchestrator issues URL explicitly",
    );
    assert.match(claude, /fail-closed/i, "CLAUDE.md must document the fail-closed routing policy");
    assert.match(
        claude,
        /never in the target project|not (?:open|file).*target\/working project|targetProjectIssues.*forbidden/i,
        "CLAUDE.md must forbid filing orchestrator issues into the target project",
    );
    assert.match(claude, /ssot\/governance\.json/, "CLAUDE.md must reference the governance SSOT as owner");
});

test("knowledge capture is a binding, role-routed, fail-closed policy", () => {
    const kc = gov.knowledgeCapture;
    assert.equal(kc.policy, "binding");
    assert.equal(kc.routingByRole.orchestrator, "CLAUDE.md");
    assert.equal(kc.routingByRole.executor, "AGENTS.md");
    assert.equal(kc.routingByRole.reviewer, ".github/copilot-instructions.md");
    assert.match(kc.obligation, /must land in a governance file|governance file/i);
    assert.match(kc.failClosed, /candidate rule|never silently drop/i);
});

test("CLAUDE.md carries the binding knowledge-capture rule", () => {
    assert.match(claude, /Continuous knowledge capture \(binding\)/);
    assert.match(claude, /generally-valid rule/i);
    // The role routing must be stated so a model knows WHERE to persist a lesson.
    assert.match(claude, /orchestrator → `CLAUDE\.md`/);
    assert.match(claude, /executor → `AGENTS\.md`/);
    assert.match(claude, /reviewer → `\.github\/copilot-instructions\.md`/);
});

test("the governance SSOT is registered in the index", () => {
    assert.match(index, /\[governance\]/, "ssot/index.toml must declare a [governance] concern");
    assert.ok(index.includes("ssot/governance.json"), "index must reference ssot/governance.json");
    assert.ok(index.includes("tests/governance-policy.test.mjs"), "index must bind this contract test");
});
