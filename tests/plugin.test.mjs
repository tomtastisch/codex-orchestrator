import { test } from "node:test";
import assert from "node:assert/strict";
import { installedVersion, installKind } from "../dist/plugin.js";
import { isOlder } from "../dist/updater.js";

test("installedVersion liest package.json (semver)", () => {
  const v = installedVersion();
  assert.match(v, /^\d+\.\d+\.\d+/, `unerwartete Version: ${v}`);
});

test("installKind erkennt git-Checkout dieses Repos", () => {
  // Läuft im Repo mit .git -> 'git'.
  assert.equal(installKind(), "git");
});

test("Versionsvergleich (isOlder) für Update-Erkennung", () => {
  assert.equal(isOlder("1.0.0", "1.1.0"), true);
  assert.equal(isOlder("1.0.0", "1.0.1"), true);
  assert.equal(isOlder("1.1.0", "1.1.0"), false);
  assert.equal(isOlder("1.1.0", "1.0.9"), false);
  assert.equal(isOlder("1.9.0", "1.10.0"), true); // numerisch, nicht lexikografisch
  assert.equal(isOlder("2.0.0", "1.9.9"), false);
});
