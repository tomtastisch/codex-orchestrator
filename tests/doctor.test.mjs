import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDoctorReport, isAuthenticated } from "../dist/doctor.js";

test("isAuthenticated erkennt angemeldeten Zustand", () => {
  assert.equal(isAuthenticated("Logged in using ChatGPT"), true);
  assert.equal(isAuthenticated("Logged in"), true);
});

test("isAuthenticated erkennt nicht-angemeldeten Zustand", () => {
  assert.equal(isAuthenticated("Not logged in"), false);
  assert.equal(isAuthenticated(""), false);
  assert.equal(isAuthenticated("error: something else"), false);
});

test("Report: fehlende Codex-CLI -> nicht bereit, Installationshinweis", () => {
  const r = buildDoctorReport({ codexVersion: null, loginStatus: "" });
  assert.equal(r.ok, false);
  assert.equal(r.codex.present, false);
  assert.equal(r.codex.authenticated, false);
  assert.ok(r.guidance.some((g) => /npm i -g @openai\/codex|ORCH_CODEX_BIN/.test(g)));
});

test("Report: vorhanden aber nicht angemeldet -> nicht bereit, Login-Hinweis", () => {
  const r = buildDoctorReport({ codexVersion: "codex-cli 0.142.5", loginStatus: "Not logged in" });
  assert.equal(r.ok, false);
  assert.equal(r.codex.present, true);
  assert.equal(r.codex.authenticated, false);
  assert.ok(r.guidance.some((g) => /codex login|OPENAI_API_KEY/.test(g)));
});

test("Report: vorhanden und angemeldet -> bereit", () => {
  const r = buildDoctorReport({ codexVersion: "codex-cli 0.142.5", loginStatus: "Logged in using ChatGPT" });
  assert.equal(r.ok, true);
  assert.equal(r.codex.present, true);
  assert.equal(r.codex.authenticated, true);
  assert.equal(r.codex.version, "codex-cli 0.142.5");
  assert.ok(r.guidance.length >= 1);
});

test("Report: SKIP_PLUGIN_MARKETPLACE spiegelt sich in Flag und Hinweis", () => {
  const prev = process.env.SKIP_PLUGIN_MARKETPLACE;
  process.env.SKIP_PLUGIN_MARKETPLACE = "true";
  try {
    const r = buildDoctorReport({ codexVersion: "codex-cli 0.142.5", loginStatus: "Logged in" });
    assert.equal(r.pluginMarketplaceSkipped, true);
    assert.ok(r.guidance.some((g) => /SKIP_PLUGIN_MARKETPLACE|claude mcp add|\.mcp\.json/.test(g)));
  } finally {
    if (prev === undefined) delete process.env.SKIP_PLUGIN_MARKETPLACE;
    else process.env.SKIP_PLUGIN_MARKETPLACE = prev;
  }
});
