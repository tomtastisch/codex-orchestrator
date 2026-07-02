import { spawn, spawnSync } from "node:child_process";

/**
 * Codex-Auto-Update (Plan-Ergänzung). Codex wird per npm-global verteilt
 * (@openai/codex). Kanäle: latest (stabil), alpha/beta (prerelease).
 */

export type Channel = "latest" | "alpha" | "beta";

export function installedVersion(codexBin = "codex"): string | null {
  const r = spawnSync(codexBin, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const m = (r.stdout || "").match(/(\d+\.\d+\.\d+[^\s]*)/);
  return m ? m[1] : (r.stdout || "").trim() || null;
}

export function latestVersion(channel: Channel): string | null {
  const r = spawnSync("npm", ["view", `@openai/codex@${channel}`, "version"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim() || null;
}

/** Vergleicht semver-artige Strings (inkl. prerelease grob). true, wenn a<b. */
export function isOlder(a: string, b: string): boolean {
  const norm = (s: string) => s.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = norm(a), pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return true;
    if (y === undefined) return false;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y;
    return String(x) < String(y);
  }
  return false;
}

export interface UpdateCheck {
  installed: string | null;
  latest: string | null;
  channel: Channel;
  updateAvailable: boolean;
}

export function checkForUpdate(channel: Channel, codexBin = "codex"): UpdateCheck {
  const installed = installedVersion(codexBin);
  const latest = latestVersion(channel);
  const updateAvailable = !!installed && !!latest && installed !== latest && isOlder(installed, latest);
  return { installed, latest, channel, updateAvailable };
}

/** Führt `npm install -g @openai/codex@<channel>` aus. Non-blocking-Wrapper. */
export function runUpdate(channel: Channel): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "-g", `@openai/codex@${channel}`], { encoding: "utf8" } as any);
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => resolve({ ok: code === 0, output: out.slice(-4000) }));
    child.on("error", (err) => resolve({ ok: false, output: String(err) }));
  });
}

/**
 * Startup-Auto-Update, gated per ENV. Läuft im Hintergrund und blockiert den
 * MCP-Handshake nicht. Nur wenn ORCH_AUTO_UPDATE != "false".
 */
export async function maybeAutoUpdate(log: (s: string) => void): Promise<void> {
  if (process.env.ORCH_AUTO_UPDATE === "false") return;
  const channel = (process.env.ORCH_CODEX_CHANNEL as Channel) || "latest";
  const check = checkForUpdate(channel);
  if (!check.updateAvailable) {
    log(`[updater] Codex ${check.installed ?? "?"} aktuell (Kanal ${channel}, latest ${check.latest ?? "?"}).`);
    return;
  }
  log(`[updater] Update ${check.installed} -> ${check.latest} (${channel}) wird installiert…`);
  const res = await runUpdate(channel);
  log(res.ok ? `[updater] Codex aktualisiert auf ${check.latest}.` : `[updater] Update fehlgeschlagen: ${res.output.slice(-300)}`);
}
