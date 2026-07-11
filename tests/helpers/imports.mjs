// Shared static import-specifier extractor for the boundary contract tests.
//
// The boundary tests enforce layering by scanning which modules a source file
// imports. A naive `from "..."` scan silently misses several ways a forbidden
// dependency can be re-introduced, which would let the very regressions these
// tests exist to catch pass green. This extractor covers every specifier form
// TypeScript/ESM can produce, in single or double quotes:
//   - static:        import x from "m"      export { y } from "m"      import type T from "m"
//   - side-effect:   import "m"
//   - dynamic:       import("m")            await import("m")
//   - require:       require("m")

const PATTERNS = [
    /\bfrom\s*['"]([^'"]+)['"]/g,            // import ... from 'm' / export ... from 'm'
    /\bimport\s+['"]([^'"]+)['"]/g,          // side-effect import 'm'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('m')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('m')
];

/**
 * Extract every module specifier a source string imports, in any form.
 * @param {string} source raw file contents
 * @returns {string[]} specifiers in source order (duplicates preserved)
 */
export function extractImports(source) {
    const specs = [];
    for (const pattern of PATTERNS) {
        for (const match of source.matchAll(pattern)) specs.push(match[1]);
    }
    return specs;
}
