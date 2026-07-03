/**
 * Sandbox-Policy (Cluster 7).
 *
 * Fail-closed: read-only ist der sichere Default (Research/Review),
 * workspace-write nur für Implementierung. `danger-full-access` (und jede
 * Variante mit voller Zugriffsstufe) ist serverseitig deaktiviert und benötigt
 * eine explizite Nutzerfreigabe, die dieser Server bewusst nicht anbietet.
 * Als reine Funktion gehalten, damit die Policy ohne Codex testbar ist.
 */
import type { Sandbox } from "./types.js";

export const ALLOWED_SANDBOXES: readonly Sandbox[] = ["read-only", "workspace-write"];
export const DEFAULT_SANDBOX: Sandbox = "read-only";

export type SandboxClass = "read-only" | "workspace-write" | "danger" | "unknown";

export function classifySandbox(s: string): SandboxClass {
  const v = s.trim().toLowerCase();
  if (v === "read-only") return "read-only";
  if (v === "workspace-write") return "workspace-write";
  if (v.includes("danger") || v.includes("full-access")) return "danger";
  return "unknown";
}

export interface SandboxCheck {
  ok: boolean;
  sandbox?: Sandbox;
  dangerous: boolean;
  error?: string;
}

/**
 * Prüft einen angeforderten Sandbox-Modus gegen die Policy.
 * Gefährliche Modi werden mit einer klaren Meldung abgelehnt (Rückfrage statt
 * blindem Scheitern) — nicht still verworfen.
 */
export function checkSandboxPolicy(requested: string): SandboxCheck {
  const cls = classifySandbox(requested);
  if (cls === "danger") {
    return {
      ok: false,
      dangerous: true,
      error:
        "Sandbox 'danger-full-access' ist serverseitig deaktiviert und benötigt eine explizite Nutzerfreigabe. " +
        "Wähle 'read-only' (Research/Review) oder 'workspace-write' (Implementierung).",
    };
  }
  if (cls === "unknown") {
    return {
      ok: false,
      dangerous: false,
      error: `Unbekannter Sandbox-Modus '${requested}'. Erlaubt: ${ALLOWED_SANDBOXES.join(", ")}.`,
    };
  }
  return { ok: true, sandbox: cls, dangerous: false };
}
