import { spawn } from "node:child_process";
import { config } from "./config.js";

/**
 * Preflight-Diagnose der Umgebung. Adressiert issue #4: statt stiller
 * Nicht-Verfügbarkeit (Codex fehlt/unangemeldet, Marketplace deaktiviert)
 * liefert der Orchestrator eine klare, handlungsleitende Statusauskunft.
 *
 * Rein & testbar getrennt: {@link buildDoctorReport} enthält die Logik,
 * {@link runDoctor} sammelt die Prozessergebnisse (argv-Spawn, fail-closed).
 */

export interface DoctorProbe {
  /** Erste Zeile von `codex --version`, oder null wenn Binary fehlt/fehlerhaft. */
  codexVersion: string | null;
  /** Roh-Ausgabe von `codex login status` (leer, wenn nicht ausgeführt). */
  loginStatus: string;
}

export interface DoctorReport {
  /** true genau dann, wenn Codex vorhanden UND angemeldet ist. */
  ok: boolean;
  node: string;
  store: string;
  codexBin: string;
  codex: { present: boolean; version: string | null; authenticated: boolean };
  /** true, wenn SKIP_PLUGIN_MARKETPLACE=true (z. B. Claude-Code-Web/Remote). */
  pluginMarketplaceSkipped: boolean;
  allowedSandboxes: ReadonlyArray<string>;
  /** Klartext-Handlungsanweisungen (leer nie: mindestens ein Hinweis). */
  guidance: string[];
}

/** Erkennt einen angemeldeten Codex-Zustand aus `codex login status`. */
export function isAuthenticated(loginStatusOutput: string): boolean {
  if (/not\s+logged\s+in/i.test(loginStatusOutput)) return false;
  return /logged\s+in/i.test(loginStatusOutput);
}

/** Reine Report-Logik (ohne Prozessaufrufe) — Grundlage der Unit-Tests. */
export function buildDoctorReport(probe: DoctorProbe): DoctorReport {
  const present = probe.codexVersion != null;
  const authenticated = present && isAuthenticated(probe.loginStatus);
  const marketplaceSkipped = process.env.SKIP_PLUGIN_MARKETPLACE === "true";

  const guidance: string[] = [];
  if (!present) {
    guidance.push(
      `Codex-CLI nicht gefunden (codexBin='${config.codexBin}'). ` +
        `Installieren via 'npm i -g @openai/codex' oder ORCH_CODEX_BIN auf den Binärpfad setzen.`,
    );
  } else if (!authenticated) {
    guidance.push(
      "Codex ist installiert, aber nicht angemeldet. 'codex login' ausführen " +
        "(oder OPENAI_API_KEY in der Umgebung bereitstellen).",
    );
  }
  if (marketplaceSkipped) {
    guidance.push(
      "SKIP_PLUGIN_MARKETPLACE=true: Der Plugin-Marketplace ist in dieser Umgebung deaktiviert " +
        "(z. B. Claude Code Web/Remote). Den MCP-Server direkt registrieren " +
        "('claude mcp add …' bzw. .mcp.json/mcpServers), statt über '/plugin marketplace add'.",
    );
  }
  if (present && authenticated && guidance.length === 0) {
    guidance.push("Bereit: Codex-CLI vorhanden und angemeldet.");
  }

  return {
    ok: present && authenticated,
    node: process.version,
    store: config.home,
    codexBin: config.codexBin,
    codex: { present, version: probe.codexVersion, authenticated },
    pluginMarketplaceSkipped: marketplaceSkipped,
    allowedSandboxes: config.allowedSandboxes,
    guidance,
  };
}

function spawnCapture(bin: string, args: string[], timeoutMs = 10_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (r: { code: number | null; out: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(bin, args, { env: process.env });
    } catch (e) {
      done({ code: null, out: (e as Error).message });
      return;
    }
    const cap = (d: Buffer) => {
      out += d.toString();
      if (out.length > 20_000) out = out.slice(-20_000);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      done({ code: null, out });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
    child.on("error", () => {
      clearTimeout(timer);
      done({ code: null, out });
    });
  });
}

/** Führt den Preflight aus: prüft Codex-Binary und Login-Status. */
export async function runDoctor(): Promise<DoctorReport> {
  const version = await spawnCapture(config.codexBin, ["--version"]);
  const codexVersion = version.code === 0 ? version.out.trim().split(/\r?\n/)[0] || null : null;
  const login = codexVersion != null ? await spawnCapture(config.codexBin, ["login", "status"]) : { code: null, out: "" };
  return buildDoctorReport({ codexVersion, loginStatus: login.out });
}
