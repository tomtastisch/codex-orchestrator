import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("obsolete plugin self-update implementation is absent", () => {
    assert.equal(existsSync("src/plugin.ts"), false);
    assert.equal(existsSync("tests/plugin.test.mjs"), false);
});

test("runtime redaction delegates to the canonical redactor", () => {
    const source = readFileSync("src/runtime/redaction.ts", "utf8");
    assert.match(source, /redactText/);
    assert.doesNotMatch(source, /new RegExp|Authorization\\s|PRIVATE KEY/);
});
