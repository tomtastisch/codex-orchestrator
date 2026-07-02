import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamLines, parseSliceResult } from "../dist/events.js";

test("parseStreamLines extrahiert thread_id, message, command, usage", () => {
  const lines = [
    '{"type":"thread.started","thread_id":"abc-123"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i0","type":"command_execution","command":"wc -l x","aggregated_output":"2 x\\n","exit_code":0}}',
    '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Fertig."}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}',
    "not json, ignore me",
  ];
  const r = parseStreamLines(lines);
  assert.equal(r.threadId, "abc-123");
  assert.equal(r.commands.length, 1);
  assert.equal(r.commands[0].exit_code, 0);
  assert.deepEqual(r.agentMessages, ["Fertig."]);
  assert.equal(r.usage.input_tokens, 10);
  assert.equal(r.turnFailed, false);
});

test("parseStreamLines ignoriert Reconnect-Rauschen, hält harte Fehler", () => {
  const r = parseStreamLines([
    '{"type":"error","message":"Reconnecting... 2/5 (401)"}',
    '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}',
  ]);
  assert.equal(r.turnFailed, true);
  assert.match(r.errorMessage, /401/);
});

test("parseSliceResult liest vollständigen Block", () => {
  const text = [
    "Some preamble.",
    "SLICE_RESULT",
    "Type: submission",
    "Cluster: C1",
    "Done in this slice:",
    "- implemented X",
    "- wrote test",
    "Changed files:",
    "- src/x.ts",
    "Tests run:",
    "- npm test: pass",
    "- lint: fail",
    "Open items:",
    "- none",
    "Next planned step:",
    "- done",
  ].join("\n");
  const sr = parseSliceResult(text);
  assert.equal(sr.parsed, true);
  assert.equal(sr.type, "submission");
  assert.equal(sr.cluster, "C1");
  assert.deepEqual(sr.doneInSlice, ["implemented X", "wrote test"]);
  assert.deepEqual(sr.changedFiles, ["src/x.ts"]);
  assert.equal(sr.testsRun.length, 2);
  assert.deepEqual(sr.testsRun[0], { cmd: "npm test", result: "pass" });
  assert.deepEqual(sr.testsRun[1], { cmd: "lint", result: "fail" });
});

test("parseSliceResult erkennt blocker und Codefences", () => {
  const text = [
    "```",
    "SLICE_RESULT",
    "Type: blocker",
    "Cluster: -",
    "Done in this slice:",
    "- investigated",
    "Open items:",
    "- need decision",
    "```",
    "BLOCKER_OR_QUESTION",
    "Context: ...",
    "Question: which DB?",
  ].join("\n");
  const sr = parseSliceResult(text);
  assert.equal(sr.type, "blocker");
  assert.match(sr.blockerText, /which DB/);
});

test("parseSliceResult ohne Block -> parsed=false", () => {
  const sr = parseSliceResult("just some prose without the marker");
  assert.equal(sr.parsed, false);
});
