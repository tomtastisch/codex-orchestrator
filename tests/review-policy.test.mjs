import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const policies = ["AGENTS.md", "CLAUDE.md"];

test("repository policy requires an exact-head independent review fallback", () => {
    for (const path of policies) {
        const policy = readFileSync(path, "utf8");
        for (const pattern of [
            /exact[- ]head/i,
            /(?:green|grüner) CI/i,
            /(?:unresolved\s+PR\s+(?:review\s+)?threads|ungelösten\s+PR-Review-Threads)/i,
            /(?:reply.*resolve|antwortet.*auflösen)/is,
            /(?:zero unresolved (?:review )?threads|keine ungelösten Review-Threads)/i,
            /clean context/i,
            /(?:read-only independent (?:review )?agent|schreibgeschützter unabhängiger\s+Review-Agent)/i,
            /Copilot.*(?:unavailable|nicht verfügbar)/is,
            /unavailable\/unknown/i,
            /(?:quota exhaustion.*explicit\s+(?:provider\s+or\s+operator\s+)?evidence|quota_exhausted.*expliziter Provider- oder Operator-Evidenz)/is,
            /(?:repeat.*explicit merge approval|bis zur expliziten Merge-Freigabe.*wiederholt)/is,
            // The three explicit triggers that each mandate the independent QA agent.
            /(?:not installed or not configured|nicht installiert oder nicht konfiguriert)/i,
            /(?:limit or quota is reached|Limit bzw\. die Quote ist erreicht)/i,
            /(?:no connection|keine Verbindung)/i,
            /Claude-intern\w*\s+QA[- ]?[Aa]gent/i,
        ]) {
            assert.match(policy, pattern, `${path} is missing ${pattern}`);
        }
    }
});

test("merge policy requires every independent finding to originate as a PR thread", () => {
    for (const path of policies) {
        const policy = readFileSync(path, "utf8");
        assert.match(policy, /(?:independent agent.*author.*separate unresolved.*PR.*thread|unabhängige Agent.*erstellt.*separaten ungelösten PR-Review-Thread)/is, path);
        assert.match(policy, /(?:every correction round.*fresh.*exact[- ]head review|Nach jeder Korrekturrunde.*neuer Exact-Head-Review)/is, path);
        assert.match(policy, /(?:merge.*only.*reviewer.*approves|Merge.*nur.*Reviewer.*freigibt)/is, path);
    }
});
