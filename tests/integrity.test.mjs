import { test } from "node:test";
import assert from "node:assert/strict";
import { detectReportDiscrepancies } from "../dist/events.js";

function sliceResult(cmd) {
  return {
    testsRun: [{ cmd, result: "pass" }],
  };
}

function command(command, exit_code) {
  return { command, exit_code, output: "" };
}

test("pass claim with matching exit 1 produces one discrepancy", () => {
  const result = detectReportDiscrepancies(
    sliceResult("npm test"),
    [command("/bin/zsh -lc 'npm test'", 1)],
  );

  assert.deepEqual(result, [{
    reported_cmd: "npm test",
    matched_command: "/bin/zsh -lc 'npm test'",
    exit_code: 1,
  }]);
});

test("pass claim with matching exit 0 produces no discrepancy", () => {
  const result = detectReportDiscrepancies(
    sliceResult("npm run build"),
    [command("npm run build", 0)],
  );

  assert.deepEqual(result, []);
});

test("last matching retry wins", () => {
  const result = detectReportDiscrepancies(
    sliceResult("npm test"),
    [command("npm test", 1), command("sh -c 'npm test'", 0)],
  );

  assert.deepEqual(result, []);
});

test("pass claim without matching command produces no discrepancy", () => {
  const result = detectReportDiscrepancies(
    sliceResult("npm test"),
    [command("npm run build", 1)],
  );

  assert.deepEqual(result, []);
});
