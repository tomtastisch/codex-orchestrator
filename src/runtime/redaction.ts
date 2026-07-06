import { redactText } from "../redact.js";

/** Backward-compatible log redaction entry point backed by the canonical engine. */
export function redact(value: string): string {
    return redactText(value);
}
