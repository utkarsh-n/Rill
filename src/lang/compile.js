// One call from source text to a checked program.

import { parse } from "./parser.js";
import { check } from "./checker.js";

export const MAX_SOURCE = 20000;

const toDiag = (e) => ({
  severity: "error",
  message: e.message,
  hint: e.hint,
  span: e.span ? { start: e.span.start, end: e.span.end, line: e.span.line, col: e.span.col } : null,
});

/**
 * @returns {{ ok, diagnostics, ast, info, tokens }}
 *   diagnostics are sorted by position; `ok` is false if any is an error.
 */
export function compile(src, { registry, env = {} }) {
  if (src.length > MAX_SOURCE) {
    return { ok: false, diagnostics: [{ severity: "error", message: `Programs are limited to ${MAX_SOURCE} characters.`, span: null }], ast: null, info: null, tokens: [] };
  }
  const { ast, errors, tokens } = parse(src);
  const diagnostics = errors.map(toDiag);
  let info = null;
  if (!errors.length) {
    const r = check(ast, { registry, env });
    diagnostics.push(...r.diagnostics.map((d) => ({ ...d, span: d.span ? { start: d.span.start, end: d.span.end, line: d.span.line, col: d.span.col } : null })));
    info = r.info;
  }
  // Keep the first message per position: later passes can repeat one.
  const seen = new Set();
  const unique = diagnostics.filter((d) => {
    const k = `${d.span?.start}:${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => (a.span?.start ?? 0) - (b.span?.start ?? 0));
  return { ok: !unique.some((d) => d.severity === "error"), diagnostics: unique, ast, info, tokens };
}
