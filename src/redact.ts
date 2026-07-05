/**
 * Secret-/Token-Redaction (Cluster 7).
 *
 * Logs und Artefakte dürfen keine Geheimnisse enthalten. Diese Funktionen
 * scrubben verbreitete Secret-Formate aus Strings (rekursiv auch in Objekten/
 * Arrays), bevor Inhalte in Audit-Events, das .toln-Artefakt oder die
 * summary.md gelangen. Konservativ: lieber ein Wert zu viel maskiert als ein
 * Token geleakt.
 */

const PLACEHOLDER = "«redacted»";

interface Pattern {
  re: RegExp;
  /** Ersetzt den gesamten Treffer (default) oder nur eine Gruppe (replace-Funktion). */
  replace?: (m: string, ...groups: string[]) => string;
}

const PATTERNS: Pattern[] = [
  // Private-Key-Blöcke (PEM).
  { re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  // OpenAI-Keys (sk-..., inkl. sk-proj-).
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  // GitHub-Tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_).
  { re: /\bgh[posru]_[A-Za-z0-9]{20,}\b/g },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  // AWS Access Key IDs.
  { re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Slack-Tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // JWTs (header.payload.signature).
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Bearer-Header.
  { re: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi, replace: () => `Bearer ${PLACEHOLDER}` },
  // key=value / key: value für sensible Schlüsselnamen (Env-Vars, Passwörter, Tokens).
  // Werte-Klasse schließt Backslash aus: verhindert das Fressen von JSON-Escapes
  // (z. B. in eingebettetem JSON des .toln) und hält die Redaction idempotent.
  {
    re: /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH|CREDENTIAL)[A-Za-z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"'\\]+)/gi,
    replace: (_m, key, sep) => `${key}${sep}${PLACEHOLDER}`,
  },
];

/** Maskiert Secrets in einem String. */
export function redactText(input: string): string {
  let out = input;
  for (const p of PATTERNS) {
    out = p.replace ? out.replace(p.re, p.replace as any) : out.replace(p.re, PLACEHOLDER);
  }
  return out;
}

/** Rekursive Redaction: scrubbt alle String-Werte in Objekten/Arrays (Keys bleiben). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as unknown as T;
  }
  return value;
}

/** True, wenn nach Redaction noch ein bekanntes Secret-Muster im Text steckt (für Tests/Guards). */
export function containsSecret(input: string): boolean {
  return redactText(input) !== input;
}
