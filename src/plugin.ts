import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { config } from "./config.js";
import { isOlder } from "./updater.js";

/**
 * Selbst-Update des Orchestrator-Plugins (getrennt von codex_update für die
 * Codex-CLI). Versionsquelle ist package.json/plugin.json; die neueste Version
 * kommt vom GitHub-Release. Ein TTL-Cache verhindert API-Aufrufe bei jedem Start.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_REPO = process.env.ORCH_PLUGIN_REPO || "tomtastisch/codex-orchestrator";
const CHECK_TTL_MS = Number(process.env.ORCH_PLUGIN_CHECK_TTL_MS || 6 * 60 * 60 * 1000);

/** Wurzel des Plugins (Modul liegt in dist/ oder bundle/, Root ist eine Ebene höher). */
function pluginRoot(): string {
  return resolve(__dirname, "..");
}

export function installedVersion(): string {
  for (const rel of ["package.json", ".claude-plugin/plugin.json"]) {
    const p = resolve(pluginRoot(), rel);
    if (existsSync(p)) {
      try {
        const v = JSON.parse(readFileSync(p, "utf8")).version;
        if (typeof v === "string" && v) return v;
      } catch { /* nächste Quelle */ }
    }
  }
  return "0.0.0";
}

export type InstallKind = "git" | "managed";

export function installKind(): InstallKind {
  return existsSync(resolve(pluginRoot(), ".git")) ? "git" : "managed";
}

function gitClean(): boolean {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: pluginRoot(), encoding: "utf8" });
  return r.status === 0 && (r.stdout || "").trim() === "";
}

interface CacheEntry {
  checkedAt: number;
  latest: string | null;
}
function cachePath(): string {
  return join(config.home, "plugin-update-check.json");
}
function readCache(): CacheEntry | null {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}
function writeCache(entry: CacheEntry): void {
  try {
    mkdirSync(config.home, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(entry), "utf8");
  } catch { /* best effort */ }
}

/**
 * Neueste veröffentlichte Version vom GitHub-Release. Nutzt den TTL-Cache;
 * `force` umgeht ihn (für explizites plugin_update check).
 * `now` wird injiziert, weil Date.now() im Workflow-Kontext nicht verfügbar ist.
 */
export async function latestVersion(now: number, force = false): Promise<string | null> {
  const cached = readCache();
  if (!force && cached && now - cached.checkedAt < CHECK_TTL_MS) {
    return cached.latest;
  }
  let latest: string | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${PLUGIN_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "codex-orchestrator" },
    });
    if (res.ok) {
      const j: any = await res.json();
      if (typeof j.tag_name === "string") latest = j.tag_name.replace(/^v/, "");
    }
  } catch { /* offline -> null */ }
  writeCache({ checkedAt: now, latest });
  return latest;
}

export interface PluginCheck {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
  install_kind: InstallKind;
  how_to_update: string;
}

export async function checkPluginUpdate(now: number, force = false): Promise<PluginCheck> {
  const installed = installedVersion();
  const latest = await latestVersion(now, force);
  const updateAvailable = !!latest && latest !== installed && isOlder(installed, latest);
  const kind = installKind();
  const how =
    kind === "git"
      ? "plugin_update(action:apply) — git pull + rebuild; danach Server/Session neu starten."
      : "In Claude Code: `/plugin marketplace update codex-orchestrator`, dann Plugin neu installieren/aktivieren. (Ein Marketplace-Plugin kann sich nicht selbst überschreiben.)";
  return { installed, latest, updateAvailable, install_kind: kind, how_to_update: how };
}

export interface PluginApplyResult {
  ok: boolean;
  applied: boolean;
  from: string;
  to: string | null;
  restart_required: boolean;
  note: string;
  output?: string;
}

/** Wendet ein Update an — nur bei sauberem git-Checkout möglich. */
export async function applyPluginUpdate(now: number): Promise<PluginApplyResult> {
  const chk = await checkPluginUpdate(now, true);
  if (!chk.updateAvailable) {
    return { ok: true, applied: false, from: chk.installed, to: chk.latest, restart_required: false, note: "bereits aktuell" };
  }
  if (chk.install_kind !== "git") {
    return {
      ok: true, applied: false, from: chk.installed, to: chk.latest, restart_required: false,
      note: chk.how_to_update,
    };
  }
  if (!gitClean()) {
    return {
      ok: false, applied: false, from: chk.installed, to: chk.latest, restart_required: false,
      note: "Arbeitsbaum nicht sauber — Auto-Update übersprungen (uncommittete Änderungen).",
    };
  }
  const root = pluginRoot();
  const steps: [string, string[]][] = [
    ["git", ["pull", "--ff-only"]],
    ["npm", ["ci"]],
    ["npm", ["run", "build"]],
    ["npm", ["run", "bundle"]],
  ];
  let output = "";
  for (const [cmd, args] of steps) {
    const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
    output += `\n$ ${cmd} ${args.join(" ")}\n${(r.stdout || "") + (r.stderr || "")}`.slice(0, 4000);
    if (r.status !== 0) {
      return { ok: false, applied: false, from: chk.installed, to: chk.latest, restart_required: false,
        note: `Schritt '${cmd} ${args.join(" ")}' fehlgeschlagen`, output: output.slice(-2000) };
    }
  }
  return {
    ok: true, applied: true, from: chk.installed, to: chk.latest, restart_required: true,
    note: "Aktualisiert. Neue Version wird beim nächsten Serverstart aktiv.", output: output.slice(-1500),
  };
}

/** Startup-Hintergrundprüfung; env-gated Auto-Apply für git-Installs. */
export async function maybePluginUpdate(now: number, log: (s: string) => void): Promise<void> {
  let chk: PluginCheck;
  try {
    chk = await checkPluginUpdate(now);
  } catch {
    return;
  }
  if (!chk.updateAvailable) {
    log(`[plugin] v${chk.installed} aktuell (latest ${chk.latest ?? "?"}, ${chk.install_kind}).`);
    return;
  }
  log(`[plugin] Update verfügbar: v${chk.installed} -> v${chk.latest}. ${chk.how_to_update}`);
  if (process.env.ORCH_PLUGIN_AUTO_UPDATE === "true" && chk.install_kind === "git") {
    log(`[plugin] Auto-Update aktiv, wende an…`);
    const res = await applyPluginUpdate(now);
    log(res.applied ? `[plugin] ${res.note}` : `[plugin] Auto-Update: ${res.note}`);
  }
}
