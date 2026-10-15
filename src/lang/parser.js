// Rill parser: tokens → AST. Statements are line-based with indented blocks; expressions use
// precedence climbing. Every node keeps its source span so errors and the inspector can point at it.

import { lex, RillError } from "./lexer.js";

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/="]);
const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);

// Binding powers (higher binds tighter).
const BP = { or: 10, and: 20, not: 30, compare: 40, range: 45, add: 50, mul: 60, neg: 70, pow: 80, post: 90 };

const join = (a, b) => ({ start: a.start, end: b.end, line: a.line, col: a.col });

export function parse(src) {
  const { tokens: all, errors } = lex(src);
  const tokens = all.filter((t) => t.type !== "COMMENT");
  const lexErrorCount = errors.length;
  let p = 0;
  const peek = (o = 0) => tokens[Math.min(p + o, tokens.length - 1)];
  const next = () => tokens[p < tokens.length - 1 ? p++ : p];
  const is = (type, value) => { const t = peek(); return t.type === type && (value === undefined || t.value === value); };
  const isOp = (v) => is("OP", v);
  const isKw = (v) => is("KEYWORD", v);
  const fail = (msg, tok = peek(), hint) => { throw new RillError(msg, tok, hint); };
  const describe = (t) =>
    t.type === "NEWLINE" ? "the end of the line" : t.type === "EOF" ? "the end of the program"
    : t.type === "INDENT" ? "an indented line" : t.type === "DEDENT" ? "the end of the block"
    : t.type === "NUMBER" ? `the number ${t.raw}` : `"${t.value}"`;
  const expectOp = (v, what) => {
    if (!isOp(v)) fail(`Expected "${v}"${what ? " " + what : ""}, found ${describe(peek())}.`);
    return next();
  };
  const expectIdent = (what) => {
    if (!is("IDENT")) {
      const t = peek();
      if (t.type === "KEYWORD") fail(`"${t.value}" is a Rill keyword, so it can't be used as ${what}.`);
      fail(`Expected ${what}, found ${describe(t)}.`);
    }
    return next();
  };
  const endStatement = () => {
    if (is("NEWLINE")) { next(); return; }
    if (is("EOF") || is("DEDENT")) return;
    const t = peek();
    if (t.type === "IDENT" && tokens[p - 1]?.type === "NUMBER")
      fail(`"${t.value}" isn't a unit Rill knows.`, t, "Try s, ms, min, m, mm, kg, N, Hz, bpm, rpm, rad, deg, m/s, m/s².");
    fail(`Expected the end of the line, found ${describe(t)}.`);
  };

  // ---- expressions ----------------------------------------------------------------------------

  function parseExpr(minBP = 0) {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      let op = null, bp = 0, right = 0;
      if (t.type === "KEYWORD" && (t.value === "or" || t.value === "and" || t.value === "mod")) {
        op = t.value;
        bp = op === "or" ? BP.or : op === "and" ? BP.and : BP.mul;
      } else if (t.type === "OP") {
        op = t.value;
        if (COMPARE.has(op)) bp = BP.compare;
        else if (op === "..") bp = BP.range;
        else if (op === "+" || op === "-") bp = BP.add;
        else if (op === "*" || op === "/") bp = BP.mul;
        else if (op === "^") { bp = BP.pow; right = -1; }
        else if (op === "(" || op === "[" || op === ".") bp = BP.post;
        else op = null;
      }
      if (!op || bp <= minBP) break;
      next();
      if (op === "(") { left = finishCall(left); continue; }
      if (op === "[") {
        const index = parseExpr();
        const close = expectOp("]", "to close the index");
        left = { type: "Index", object: left, index, span: join(left.span, close) };
        continue;
      }
      if (op === ".") {
        const name = expectIdent("a name after the dot");
        left = { type: "Member", object: left, name: name.value, nameSpan: name, span: join(left.span, name) };
        continue;
      }
      const rhs = parseExpr(bp + right);
      if (COMPARE.has(op) && COMPARE.has(peek().value) && peek().type === "OP")
        fail("Comparisons can't be chained. Join them with and: 0 < x and x < 1", peek());
      if (op === "..") { left = { type: "Range", from: left, to: rhs, span: join(left.span, rhs.span) }; continue; }
      left = { type: "Binary", op, left, right: rhs, span: join(left.span, rhs.span) };
    }
    return left;
  }

  function finishCall(callee) {
    const args = [];
    while (!isOp(")")) {
      let name = null;
      // Named value: name: expr. Keywords are fine as names here (tank.poke(at: …)).
      if ((is("IDENT") || is("KEYWORD")) && peek(1).type === "OP" && peek(1).value === ":") {
        name = next();
        next();
      }
      const expr = parseExpr();
      args.push({ name: name?.value ?? null, nameSpan: name ?? null, expr });
      if (!isOp(",")) break;
      next();
    }
    const close = expectOp(")", "to close the call");
    return { type: "Call", callee, args, span: join(callee.span, close) };
  }

  function parsePrefix() {
    const t = peek();
    if (t.type === "NUMBER") {
      next();
      return { type: "Num", value: t.value, dim: t.dim, unit: t.unit, raw: t.raw, span: t };
    }
    if (t.type === "KEYWORD") {
      if (t.value === "true" || t.value === "false") {
        next();
        return { type: "Bool", value: t.value === "true", span: t };
      }
      if (t.value === "not") {
        next();
        const arg = parseExpr(BP.not);
        return { type: "Unary", op: "not", arg, span: join(t, arg.span) };
      }
      if (t.value === "if") {
        next();
        const cond = parseExpr();
        if (!isKw("then")) fail('An if inside an expression needs "then" and "else": if x > 0 then 1 else 2');
        next();
        const a = parseExpr();
        if (!isKw("else")) fail('An if inside an expression needs an "else" value.');
        next();
        const b = parseExpr(BP.or - 1);
        return { type: "IfExpr", cond, then: a, else: b, span: join(t, b.span) };
      }
      fail(`"${t.value}" can't start an expression.`);
    }
    if (t.type === "IDENT") {
      next();
      return { type: "Ident", name: t.value, span: t };
    }
    if (t.type === "OP") {
      if (t.value === "-" || t.value === "+") {
        next();
        const arg = parseExpr(BP.neg);
        return t.value === "-" ? { type: "Unary", op: "-", arg, span: join(t, arg.span) } : arg;
      }
      if (t.value === "(") {
        next();
        if (isOp(")")) fail("Empty parentheses don't make a value.");
        const first = parseExpr();
        if (isOp(")")) { next(); return first; }
        const items = [first];
        while (isOp(",")) { next(); if (isOp(")")) break; items.push(parseExpr()); }
        const close = expectOp(")", "to close the vector");
        return { type: "Tuple", items, span: join(t, close) };
      }
      if (t.value === "[") {
        next();
        const items = [];
        while (!isOp("]")) {
          items.push(parseExpr());
          if (!isOp(",")) break;
          next();
        }
        const close = expectOp("]", "to close the list");
        return { type: "List", items, span: join(t, close) };
      }
    }
    fail(`Expected a value, found ${describe(t)}.`);
  }

  // ---- statements -----------------------------------------------------------------------------

  function parseBlock() {
    const colon = expectOp(":", "to start the block");
    if (is("NEWLINE")) {
      next();
      if (!is("INDENT")) fail("This block is empty. Indent the lines that belong to it.", peek());
      next();
      const body = [];
      while (!is("DEDENT") && !is("EOF")) statementInto(body);
      if (is("DEDENT")) next();
      return body;
    }
    if (is("EOF")) fail("This block is empty.", colon);
    const t = peek();
    if (t.type === "KEYWORD" && ["every", "on", "when", "at", "always", "fn", "if", "for", "repeat", "use", "seed", "var"].includes(t.value))
      fail(`Put "${t.value}" on its own indented line.`);
    return [parseSimple()];
  }

  function parseSimple() {
    const t = peek();
    if (t.type === "KEYWORD" && t.value === "let") return parseLet(false);
    if (t.type === "KEYWORD" && t.value === "return") {
      next();
      const expr = is("NEWLINE") || is("EOF") || is("DEDENT") ? null : parseExpr();
      endStatement();
      return { type: "Return", expr, span: expr ? join(t, expr.span) : t };
    }
    const expr = parseExpr();
    if (is("OP") && ASSIGN_OPS.has(peek().value)) {
      const op = next().value;
      if (!["Ident", "Member", "Index"].includes(expr.type)) fail("Only a var or an instrument setting can be changed.", expr.span);
      const value = parseExpr();
      endStatement();
      return { type: "Assign", op, target: expr, expr: value, span: join(expr.span, value.span) };
    }
    if (isOp(":") && expr.type === "Ident")
      fail(`"${expr.name}" isn't a Rill keyword. Blocks start with every, on, when, at, always, if, for or repeat.`, expr.span);
    endStatement();
    return { type: "ExprStmt", expr, span: expr.span };
  }

  function parseLet(isVar) {
    const kw = next();
    const name = expectIdent(`a name for the ${isVar ? "var" : "let"}`);
    expectOp("=", `after ${name.value}`);
    const expr = parseExpr();
    endStatement();
    return { type: "Let", isVar, name: name.value, nameSpan: name, expr, span: join(kw, expr.span) };
  }

  function parseStatement() {
    const t = peek();
    if (t.type === "INDENT") fail("This line is indented, but nothing above it opens a block.");
    if (t.type !== "KEYWORD") return parseSimple();
    switch (t.value) {
      case "use": {
        next();
        const names = [];
        do {
          if (names.length) next();
          const n = expectIdent("an instrument name");
          names.push({ name: n.value, span: n });
        } while (isOp(","));
        endStatement();
        return { type: "Use", names, span: join(t, names[names.length - 1].span) };
      }
      case "seed": {
        next();
        const expr = parseExpr();
        endStatement();
        return { type: "Seed", expr, span: join(t, expr.span) };
      }
      case "let": return parseLet(false);
      case "var": return parseLet(true);
      case "fn": {
        next();
        const name = expectIdent("a function name");
        expectOp("(", `after ${name.value}`);
        const params = [];
        while (!isOp(")")) {
          const pn = expectIdent("a parameter name");
          params.push({ name: pn.value, span: pn });
          if (!isOp(",")) break;
          next();
        }
        expectOp(")", "to close the parameters");
        const body = parseBlock();
        return { type: "Fn", name: name.value, nameSpan: name, params, body, span: join(t, name) };
      }
      case "every": case "when": case "at": {
        next();
        const expr = parseExpr();
        const body = parseBlock();
        const type = t.value === "every" ? "Every" : t.value === "when" ? "When" : "At";
        return { type, expr, body, span: join(t, expr.span) };
      }
      case "on": {
        next();
        const expr = parseExpr();
        const body = parseBlock();
        return { type: "On", expr, body, span: join(t, expr.span) };
      }
      case "always": {
        next();
        const body = parseBlock();
        return { type: "Always", body, span: t };
      }
      case "if": {
        next();
        const branches = [];
        const cond = parseExpr();
        branches.push({ cond, body: parseBlock() });
        let elseBody = null;
        for (;;) {
          if (isKw("elif")) { next(); const c = parseExpr(); branches.push({ cond: c, body: parseBlock() }); continue; }
          if (isKw("else")) { next(); elseBody = parseBlock(); }
          break;
        }
        return { type: "If", branches, else: elseBody, span: join(t, cond.span) };
      }
      case "for": {
        next();
        const name = expectIdent("a loop variable");
        if (!isKw("in")) fail('Expected "in": for i in 1..8');
        next();
        const iter = parseExpr();
        const body = parseBlock();
        return { type: "For", name: name.value, nameSpan: name, iter, body, span: join(t, iter.span) };
      }
      case "repeat": {
        next();
        const expr = parseExpr();
        const body = parseBlock();
        return { type: "Repeat", expr, body, span: join(t, expr.span) };
      }
      case "elif": case "else":
        fail(`"${t.value}" needs an if directly above it.`);
      case "return":
        return parseSimple();
      default:
        return parseSimple();
    }
  }

  /** Parse one statement, recording an error and skipping to the next line on failure. */
  function statementInto(list) {
    while (is("NEWLINE")) next();
    if (is("EOF") || is("DEDENT")) return;
    const start = p;
    try {
      list.push(parseStatement());
    } catch (e) {
      if (!(e instanceof RillError)) throw e;
      errors.push(e);
      // Recover: skip the rest of this line and any block hanging off it.
      if (p === start) next();
      let depth = 0;
      while (!is("EOF")) {
        const t = peek();
        if (t.type === "INDENT") depth++;
        else if (t.type === "DEDENT") { if (depth === 0) break; depth--; }
        else if (t.type === "NEWLINE" && depth === 0) {
          next();
          if (is("INDENT")) continue;
          break;
        }
        next();
      }
    }
  }

  const body = [];
  while (!is("EOF")) {
    const before = p;
    statementInto(body);
    if (is("DEDENT")) next();
    if (p === before) next();
  }
  // A bad character already explains its line; drop the parse errors it caused there.
  const lexLines = new Set(lexErrorCount ? errors.slice(0, lexErrorCount).map((e) => e.span.line) : []);
  const kept = errors.filter((e, i) => i < lexErrorCount || !lexLines.has(e.span?.line));
  return { ast: { type: "Program", body }, errors: kept, tokens: all };
}
