// Rill lexer: source text → tokens with exact spans. Indentation becomes INDENT/DEDENT tokens;
// newlines inside brackets are ignored. Rill has no string literals, by design.

import { scanUnit } from "./units.js";

export const KEYWORDS = new Set([
  "use", "seed", "let", "var", "fn", "every", "on", "when", "at", "always", "if", "elif", "else",
  "then", "for", "in", "repeat", "return", "and", "or", "not", "mod", "true", "false",
]);

const OPS2 = ["==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", ".."];
const OPS1 = "+-*/^=<>()[],:.";

export class RillError extends Error {
  /** @param {{start:number,end:number,line:number,col:number}} span */
  constructor(message, span, hint) {
    super(message);
    this.span = span;
    this.hint = hint;
  }
}

const isIdStart = (c) => c !== undefined && /[\p{L}_]/u.test(c);
const isIdPart = (c) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/**
 * Tokenise. Returns { tokens, errors } and never throws: a bad character becomes an error and is
 * skipped, so the editor can still highlight the rest of the line.
 */
export function lex(src) {
  const tokens = [];
  const errors = [];
  const indents = [0];
  let i = 0, line = 1, lineStart = 0, depth = 0, atLineStart = true;
  const span = (start, end) => ({ start, end, line, col: start - lineStart + 1 });
  const push = (type, value, start, end, extra) => tokens.push({ type, value, ...span(start, end), ...extra });

  while (i <= src.length) {
    if (atLineStart && depth > 0) atLineStart = false;
    if (atLineStart && depth === 0) {
      // Measure indentation; blank and comment-only lines don't count.
      let col = 0, j = i;
      while (src[j] === " " || src[j] === "\t") { col += src[j] === "\t" ? 4 - (col % 4) : 1; j++; }
      const rest = src[j];
      if (rest === "\n" || rest === "\r" || (rest === "-" && src[j + 1] === "-") || j >= src.length) {
        if (j >= src.length) { i = j; break; }
        i = j; // fall through: the comment/newline handling below consumes the line
      } else {
        const top = indents[indents.length - 1];
        if (col > top) { indents.push(col); push("INDENT", null, j, j); }
        else if (col < top) {
          while (indents[indents.length - 1] > col) { indents.pop(); push("DEDENT", null, j, j); }
          if (indents[indents.length - 1] !== col)
            errors.push(new RillError("This line's indentation doesn't match any block above it.", span(i, j)));
        }
        i = j;
        atLineStart = false;
      }
    }
    if (i >= src.length) break;
    const c = src[i];

    if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      if (depth === 0 && !atLineStart) push("NEWLINE", null, i, i + 1);
      i++;
      line++;
      lineStart = i;
      atLineStart = true;
      continue;
    }
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "-" && src[i + 1] === "-") {
      const s = i;
      while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
      push("COMMENT", src.slice(s, i), s, i);
      continue;
    }

    // Numbers, with an optional unit attached on the same line: 9.81 m/s², 120 bpm, 50%.
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? "") && src[i - 1] !== ".")) {
      const s = i;
      while (/[0-9_]/.test(src[i] ?? "")) i++;
      if (src[i] === "." && src[i + 1] !== "." && /[0-9]/.test(src[i + 1] ?? "")) {
        i++;
        while (/[0-9_]/.test(src[i] ?? "")) i++;
      }
      if ((src[i] === "e" || src[i] === "E") && /[0-9]/.test(src[i + 1] === "-" || src[i + 1] === "+" ? src[i + 2] ?? "" : src[i + 1] ?? "")) {
        i += src[i + 1] === "-" || src[i + 1] === "+" ? 2 : 1;
        while (/[0-9]/.test(src[i] ?? "")) i++;
      }
      const raw = src.slice(s, i);
      let value = Number(raw.replaceAll("_", ""));
      const numEnd = i;
      // Unit: either directly attached ("50%") or after spaces on the same line ("2 m").
      let j = i;
      while (src[j] === " " || src[j] === "\t") j++;
      const u = scanUnit(src, j);
      if (u && !isIdPart(src[u.end])) {
        i = u.end;
        push("NUMBER", value * u.scale + u.offset, s, i, {
          raw, dim: u.dim, unit: u.text, numEnd, unitStart: j,
        });
      } else {
        push("NUMBER", value, s, i, { raw, dim: null, unit: "", numEnd, unitStart: i });
      }
      if (isIdStart(src[i]) && !(u && u.end === i)) {
        // "2sec": a word glued to a number that isn't a known unit.
        let k = i;
        while (isIdPart(src[k])) k++;
        errors.push(new RillError(
          `"${src.slice(i, k)}" isn't a unit Rill knows.`, span(i, k),
          "Units come right after the number: 2 s, 9.81 m/s², 120 bpm, 3000 rpm.",
        ));
        i = k;
      }
      continue;
    }

    if (isIdStart(c)) {
      const s = i;
      while (isIdPart(src[i])) i++;
      const word = src.slice(s, i);
      push(KEYWORDS.has(word) ? "KEYWORD" : "IDENT", word, s, i);
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const s = i;
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") i++;
      if (src[i] === c) i++;
      errors.push(new RillError(
        "Rill has no text values. Everything a program makes is a shape, a motion or a sound.",
        span(s, i), "Name a choice directly instead, e.g. tank.material = honey",
      ));
      continue;
    }

    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { push("OP", two, i, i + 2); i += 2; continue; }
    if (OPS1.includes(c)) {
      if (c === "(" || c === "[") depth++;
      if ((c === ")" || c === "]") && depth > 0) depth--;
      push("OP", c, i, i + 1);
      i++;
      continue;
    }
    if (c === "π" || c === "τ") { push("IDENT", c, i, i + 1); i++; continue; }
    errors.push(new RillError(`Unexpected character "${c}".`, span(i, i + 1)));
    i++;
  }
  if (tokens.length && tokens[tokens.length - 1].type !== "NEWLINE" && depth === 0) {
    const last = tokens[tokens.length - 1];
    if (last.type !== "INDENT" && last.type !== "DEDENT") push("NEWLINE", null, src.length, src.length);
  }
  while (indents.length > 1) { indents.pop(); push("DEDENT", null, src.length, src.length); }
  push("EOF", null, src.length, src.length);
  return { tokens, errors };
}
