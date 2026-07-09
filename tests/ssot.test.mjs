import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const index = readFileSync("ssot/index.toml", "utf8");

test("SSOT index references every leaf configuration file", () => {
    const leafFiles = readdirSync("ssot").filter((name) => name.endsWith(".json")).sort();
    assert.ok(leafFiles.length > 0, "ssot/ must contain at least one JSON source of truth");
    for (const leaf of leafFiles) {
        assert.ok(index.includes(`ssot/${leaf}`), `ssot/index.toml does not reference ssot/${leaf}`);
    }
});

test("every leaf file the SSOT index declares exists and parses", () => {
    const referenced = [...index.matchAll(/file\s*=\s*"(ssot\/[\w.-]+\.json)"/g)].map((match) => match[1]);
    assert.ok(referenced.length > 0, "ssot/index.toml declares no leaf files");
    for (const path of referenced) {
        assert.equal(existsSync(path), true, `ssot/index.toml references a missing file: ${path}`);
        assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")), `invalid JSON in ${path}`);
    }
});
