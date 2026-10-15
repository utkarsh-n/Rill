// Rill checker: names, units, types and provenance, all before the program runs.
//
// Provenance is flow-insensitive for state that outlives a tick (vars and instrument settings):
// a var's provenance is the join of everything ever assigned to it. The checker repeats until those
// joins stop changing (they only rise through a finite lattice, so it always settles).

import { DIMLESS, dimEq, dimMul, dimDiv, dimPow, dimName, isDimless, U } from "./units.js";
import { P, joinProv, provName } from "./provenance.js";
import { T, describe, sameType, joinTypes, withProv, typeKey } from "./types.js";
import { BUILTINS, CONSTANTS, CLOCK } from "./builtins.js";

const SECONDS = U("s");
const TOP_ONLY = { Use: "use", Seed: "seed", Fn: "fn", Every: "every", On: "on", When: "when", At: "at", Always: "always" };

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function suggest(name, candidates) {
  let best = null, score = Infinity;
  for (const c of candidates) {
    const s = lev(name.toLowerCase(), c.toLowerCase());
    if (s < score) { score = s; best = c; }
  }
  return best && score <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

/** Static type of an instrument setting or reading. */
export function specType(spec, prov) {
  switch (spec.type) {
    case "num": return T.num(spec.dim, prov);
    case "bool": return T.bool(prov);
    case "enum": return T.enm(spec.values, prov);
    case "vec": return T.vec(spec.n, spec.dim, prov);
    default: return T.err();
  }
}
const readProv = (spec, env) => P[typeof spec.prov === "function" ? spec.prov(env) : spec.prov ?? "modelled"];

/**
 * @param ast Program node from parser.js (annotated in place with `.r` resolutions)
 * @param opts.registry Map<name, manifest> of instruments the page offers
 * @param opts.env { motion: boolean, ... } facts about the viewer's device that affect provenance
 */
export function check(ast, { registry, env = {} }) {
  const flow = { varProv: new Map(), paramProv: new Map(), probe: new Map() };
  const key = () => JSON.stringify([[...flow.varProv], [...flow.paramProv], [...flow.probe]]);
  let result;
  for (let pass = 0; pass < 16; pass++) {
    const before = key();
    result = runPass(ast, registry, env, flow);
    if (key() === before) break;
  }
  return result;
}

function runPass(ast, registry, env, flow) {
  const diagnostics = [];
  const err = (message, span, hint) => diagnostics.push({ severity: "error", message, span, hint });
  const warn = (message, span, hint) => diagnostics.push({ severity: "warning", message, span, hint });

  const used = new Map();
  const globals = new Map();
  const fns = new Map();
  const setup = [], handlers = [];
  let seed = 1;
  const fnCache = new Map();
  const fnStack = [];
  const calledFns = new Set();

  const reserved = (name) =>
    used.has(name) || registry.has(name) || BUILTINS.has(name) || CONSTANTS.has(name) || CLOCK.has(name) || fns.has(name);

  // ---- declarations ---------------------------------------------------------------------------
  for (const s of ast.body) {
    if (s.type === "Use") {
      for (const { name, span } of s.names) {
        if (!registry.has(name)) {
          const near = suggest(name, [...registry.keys()]);
          err(`There's no instrument called ${name}.`, span, near ? `Did you mean ${near}?` : `Instruments: ${[...registry.keys()].join(", ")}.`);
        } else if (used.has(name)) warn(`${name} is already on the page.`, span);
        else used.set(name, registry.get(name));
      }
    } else if (s.type === "Fn") {
      if (fns.has(s.name)) err(`There's already a function called ${s.name}.`, s.nameSpan);
      else if (BUILTINS.has(s.name) || registry.has(s.name) || CONSTANTS.has(s.name) || CLOCK.has(s.name))
        err(`${s.name} is already a Rill name; pick another.`, s.nameSpan);
      else fns.set(s.name, s);
    }
  }
  for (const s of ast.body) {
    if (s.type !== "Let") continue;
    if (globals.has(s.name)) err(`${s.name} is already defined above.`, s.nameSpan);
    else if (reserved(s.name)) err(`${s.name} is already a Rill name; pick another.`, s.nameSpan);
    else globals.set(s.name, { isVar: s.isVar, type: null, span: s.nameSpan, node: s });
  }

  // ---- names ----------------------------------------------------------------------------------
  function lookupLocal(ctx, name) {
    for (let i = ctx.scopes.length - 1; i >= 0; i--) if (ctx.scopes[i].has(name)) return ctx.scopes[i].get(name);
    return null;
  }
  function visibleNames(ctx) {
    const names = new Set([...globals.keys(), ...used.keys(), ...CONSTANTS.keys(), ...CLOCK.keys()]);
    for (const s of ctx.scopes) for (const k of s.keys()) names.add(k);
    return names;
  }
  /** Is this a bare word that names nothing, so it may be a preset or choice? */
  const isFreeWord = (node, ctx) =>
    node.type === "Ident" && !lookupLocal(ctx, node.name) && !globals.has(node.name) && !used.has(node.name) &&
    !CONSTANTS.has(node.name) && !CLOCK.has(node.name) && !registry.has(node.name);

  function resolveIdent(node, ctx) {
    const { name, span } = node;
    const local = lookupLocal(ctx, name);
    if (local) { node.r = { kind: "local" }; return local.type; }
    const g = globals.get(name);
    if (g) {
      node.r = { kind: "global" };
      if (!g.type) {
        err(`${name} is used before its ${g.isVar ? "var" : "let"} line runs.`, span, "Move the definition above this line.");
        return T.err();
      }
      return g.isVar ? withProv(g.type, flow.varProv.get(name) ?? 0) : g.type;
    }
    if (CLOCK.has(name)) { node.r = { kind: "clock", name }; return CLOCK.get(name); }
    if (CONSTANTS.has(name)) { const c = CONSTANTS.get(name); node.r = { kind: "const", value: c.value }; return c.type; }
    if (used.has(name)) { node.r = { kind: "instr", name }; return T.instr(name); }
    if (registry.has(name)) {
      err(`${name} isn't on this page yet.`, span, `Add "use ${name}" at the top to bring it in.`);
      return T.err();
    }
    if (BUILTINS.has(name) || fns.has(name)) {
      err(`${name} is a function. Call it with parentheses: ${name}(…)`, span);
      return T.err();
    }
    const near = suggest(name, visibleNames(ctx));
    err(`Nothing called ${name} exists here.`, span, near ? `Did you mean ${near}?` : "Define it with let or var first.");
    return T.err();
  }

  // ---- instrument members ---------------------------------------------------------------------
  const pkey = (instr, name) => `${instr}.${name}`;
  function paramType(instr, name, spec) {
    if (spec.type === "probe") {
      const pr = flow.probe.get(pkey(instr, name));
      return pr ? T.num(pr.dim, pr.prov) : T.num(DIMLESS, P.set);
    }
    return specType(spec, flow.paramProv.get(pkey(instr, name)) ?? P.set);
  }
  /** Resolve `instr.name`. mode: read | write | action | event. Returns { type, spec, kind } or null. */
  function member(node, ctx, mode) {
    const obj = node.object;
    let instr = null;
    if (obj.type === "Ident" && !lookupLocal(ctx, obj.name) && !globals.has(obj.name)) {
      if (used.has(obj.name)) { instr = obj.name; obj.r = { kind: "instr", name: instr }; }
      else if (registry.has(obj.name)) {
        err(`${obj.name} isn't on this page yet.`, obj.span, `Add "use ${obj.name}" at the top to bring it in.`);
        return null;
      }
    }
    if (!instr) {
      // A component of a vector: v.x, v.y, v.z, v.w.
      const t = checkExpr(obj, ctx);
      if (t.k === "err") return null;
      const i = "xyzw".indexOf(node.name);
      if (t.k === "vec" && node.name.length === 1 && i >= 0 && i < t.n) {
        if (mode !== "read") { err("A vector's parts can't be changed one at a time; assign the whole vector.", node.span); return null; }
        node.r = { kind: "comp", i };
        return { type: T.num(t.dim, t.prov), kind: "comp" };
      }
      err(`${describe(t)} has no .${node.name}.`, node.nameSpan, t.k === "vec" ? `Its parts are ${"xyzw".slice(0, t.n).split("").join(", ")}.` : undefined);
      return null;
    }
    const m = used.get(instr);
    const has = (o, k) => o && Object.hasOwn(o, k);
    const all = () => [...Object.keys(m.params ?? {}), ...Object.keys(m.reads ?? {}), ...Object.keys(m.actions ?? {}), ...Object.keys(m.events ?? {})];
    let kind = null, spec = null;
    if (has(m.params, node.name)) { kind = "param"; spec = m.params[node.name]; }
    else if (has(m.reads, node.name)) { kind = "read"; spec = m.reads[node.name]; }
    else if (has(m.actions, node.name)) { kind = "action"; spec = m.actions[node.name]; }
    else if (has(m.events, node.name)) { kind = "event"; spec = m.events[node.name]; }
    if (!kind) {
      const near = suggest(node.name, all());
      err(`${instr} has no ${node.name}.`, node.nameSpan, near ? `Did you mean ${instr}.${near}?` : `${instr} has: ${all().join(", ")}.`);
      return null;
    }
    node.r = { kind, instr, name: node.name };
    const full = `${instr}.${node.name}`;
    if (mode === "read" || mode === "write") {
      if (kind === "action") { err(`${full} is an action. Call it: ${full}(…)`, node.span); return null; }
      if (kind === "event") { err(`${full} is an event. React to it with "on ${full}:"`, node.span); return null; }
      if (mode === "write" && kind === "read") {
        err(`${full} is a reading. ${m.title ?? instr} works it out; a program can't set it.`, node.span,
          Object.keys(m.params ?? {}).length ? `Settings you can change: ${Object.keys(m.params).join(", ")}.` : undefined);
        return null;
      }
      const type = kind === "param" ? paramType(instr, node.name, spec) : specType(spec, readProv(spec, env));
      return { type, spec, kind, instr };
    }
    if (mode === "action" && kind !== "action") { err(`${full} isn't an action, so it can't be called.`, node.span); return null; }
    if (mode === "event" && kind !== "event") {
      err(`${full} isn't an event.`, node.span, kind === "read" && spec.type === "bool" ? `To react when it becomes true, use "when ${full}:"` : `${instr}'s events: ${Object.keys(m.events ?? {}).join(", ") || "none"}.`);
      return null;
    }
    return { spec, kind, instr };
  }

  /** Check `node` against an expected setting/argument spec, allowing bare preset/choice words. */
  function expectSpec(spec, node, ctx, what) {
    if (isFreeWord(node, ctx)) {
      if (spec.type === "enum" && spec.values.includes(node.name)) {
        node.r = { kind: "literal", value: node.name };
        return T.enm(spec.values, P.set);
      }
      if (spec.type === "num" && spec.presets && Object.hasOwn(spec.presets, node.name)) {
        node.r = { kind: "literal", value: spec.presets[node.name] };
        return T.num(spec.dim, P.set);
      }
      const options = spec.type === "enum" ? spec.values : spec.presets ? Object.keys(spec.presets) : [];
      if (options.length) {
        const near = suggest(node.name, options);
        err(`${what} has no choice called ${node.name}.`, node.span, `${near ? `Did you mean ${near}? ` : ""}Choices: ${options.join(", ")}.`);
        return T.err();
      }
    }
    const t = checkExpr(node, ctx);
    if (t.k === "err") return t;
    if (spec.type === "probe") {
      if (t.k !== "num") { err(`${what} plots numbers, not ${describe(t)}.`, node.span); return T.err(); }
      return t;
    }
    const want = specType(spec, 0);
    if (!sameType(want, t)) {
      const hint =
        want.k === "num" && t.k === "num"
          ? `${what} is measured in ${dimName(want.dim) || "plain numbers"}${spec.display ? ` (e.g. ${spec.display})` : ""}; this is ${dimName(t.dim) || "a plain number"}.`
          : want.k === "enum" ? `Choices: ${spec.values.join(", ")}.` : undefined;
      err(`${what} needs ${describe(want)}, not ${describe(t)}.`, node.span, hint);
      return T.err();
    }
    if (spec.type === "num" && node.type === "Num" && Number.isFinite(spec.min) && Number.isFinite(spec.max)) {
      if (node.value < spec.min || node.value > spec.max)
        warn(`${what} only goes from ${fmtRange(spec)}, so this will be held at the limit.`, node.span);
    }
    return t;
  }

  // ---- expressions ----------------------------------------------------------------------------
  function checkExpr(node, ctx) {
    switch (node.type) {
      case "Num": return T.num(node.dim ?? DIMLESS, P.set);
      case "Bool": return T.bool(P.set);
      case "Ident": return resolveIdent(node, ctx);
      case "Unary": {
        const t = checkExpr(node.arg, ctx);
        if (t.k === "err") return t;
        if (node.op === "not") {
          if (t.k !== "bool") { err(`"not" needs true/false, not ${describe(t)}.`, node.arg.span); return T.err(); }
          return t;
        }
        if (t.k !== "num" && t.k !== "vec") { err(`Can't negate ${describe(t)}.`, node.span); return T.err(); }
        return t;
      }
      case "Binary": return checkBinary(node, ctx);
      case "IfExpr": {
        const c = checkExpr(node.cond, ctx);
        if (c.k !== "bool" && c.k !== "err") err(`The condition needs to be true/false, not ${describe(c)}.`, node.cond.span);
        const a = checkExpr(node.then, ctx), b = checkExpr(node.else, ctx);
        if (!sameType(a, b)) { err(`Both branches need the same kind of value: ${describe(a)} vs ${describe(b)}.`, node.span); return T.err(); }
        return withProv(joinTypes(a, b), c.prov ?? 0);
      }
      case "Tuple": {
        const ts = node.items.map((n) => checkExpr(n, ctx));
        if (ts.some((t) => t.k === "err")) return T.err();
        if (ts.length > 4) { err("Vectors have at most 4 parts.", node.span); return T.err(); }
        const bad = ts.findIndex((t) => t.k !== "num");
        if (bad >= 0) { err(`A vector's parts are numbers, not ${describe(ts[bad])}.`, node.items[bad].span); return T.err(); }
        const d = ts[0].dim;
        const off = ts.findIndex((t) => !dimEq(t.dim, d));
        if (off >= 0) {
          err(`Every part of a vector needs the same unit: ${dimName(d) || "plain"} vs ${dimName(ts[off].dim) || "plain"}.`, node.items[off].span,
            isDimless(ts[off].dim) || isDimless(d) ? "Give each part its unit, e.g. (0 m/s, 2 m/s)." : undefined);
          return T.err();
        }
        return T.vec(ts.length, d, joinProv(...ts.map((t) => t.prov)));
      }
      case "List": {
        if (!node.items.length) { err("Rill can't tell what goes in an empty list. Start it with at least one value.", node.span); return T.err(); }
        if (node.items.length > 4096) { err("Lists hold at most 4096 values.", node.span); return T.err(); }
        const ts = node.items.map((n) => checkExpr(n, ctx));
        let acc = ts[0];
        for (let i = 1; i < ts.length; i++) {
          if (!sameType(acc, ts[i])) { err(`Everything in a list needs the same kind: ${describe(acc)} vs ${describe(ts[i])}.`, node.items[i].span); return T.err(); }
          acc = joinTypes(acc, ts[i]);
        }
        if (acc.k === "err") return T.err();
        return T.list(acc);
      }
      case "Range": {
        const a = checkExpr(node.from, ctx), b = checkExpr(node.to, ctx);
        for (const [t, n] of [[a, node.from], [b, node.to]])
          if (t.k !== "err" && !(t.k === "num" && isDimless(t.dim))) err(`Ranges count plain whole numbers: 1..8, not ${describe(t)}.`, n.span);
        return T.list(T.num(DIMLESS, joinProv(a.prov ?? 0, b.prov ?? 0)));
      }
      case "Member": {
        const r = member(node, ctx, "read");
        return r ? r.type : T.err();
      }
      case "Index": {
        const o = checkExpr(node.object, ctx), i = checkExpr(node.index, ctx);
        if (i.k !== "err" && !(i.k === "num" && isDimless(i.dim))) err(`Positions are plain whole numbers, not ${describe(i)}.`, node.index.span);
        if (o.k === "list") return withProv(o.of, i.prov ?? 0);
        if (o.k === "vec") return T.num(o.dim, joinProv(o.prov, i.prov ?? 0));
        if (o.k !== "err") err(`Only lists and vectors have positions, not ${describe(o)}.`, node.object.span);
        return T.err();
      }
      case "Call": return checkCall(node, ctx);
      default:
        err("This can't be used as a value.", node.span);
        return T.err();
    }
  }

  function checkBinary(node, ctx) {
    const { op } = node;
    // An enum compared against a bare choice word: tank.material == honey
    if ((op === "==" || op === "!=") && (isFreeWord(node.left, ctx) || isFreeWord(node.right, ctx))) {
      const [word, other] = isFreeWord(node.left, ctx) ? [node.left, node.right] : [node.right, node.left];
      const ot = checkExpr(other, ctx);
      if (ot.k === "enum") {
        if (!ot.values.includes(word.name)) { err(`${word.name} isn't one of ${ot.values.join(", ")}.`, word.span); return T.err(); }
        word.r = { kind: "literal", value: word.name };
        return T.bool(ot.prov);
      }
      if (ot.k === "err") return T.err();
      resolveIdent(word, ctx);
      return T.err();
    }
    const a = checkExpr(node.left, ctx), b = checkExpr(node.right, ctx);
    if (a.k === "err" || b.k === "err") return T.err();
    const prov = joinProv(a.prov, b.prov);
    const unitMsg = (verb) =>
      `Can't ${verb} ${dimName(a.dim) || "a plain number"} and ${dimName(b.dim) || "a plain number"}.`;
    const plainHint = (x, y) => (isDimless(x.dim) !== isDimless(y.dim) ? "Give the plain number a unit, e.g. 2 m instead of 2." : undefined);
    switch (op) {
      case "and": case "or":
        if (a.k !== "bool" || b.k !== "bool") { err(`"${op}" joins true/false values, not ${describe(a.k !== "bool" ? a : b)}.`, node.span); return T.err(); }
        return T.bool(prov);
      case "==": case "!=":
        if (!sameType(a, b)) { err(`Can't compare ${describe(a)} with ${describe(b)}.`, node.span, plainHint(a, b)); return T.err(); }
        if (a.k === "list") { err("Lists can't be compared with ==.", node.span); return T.err(); }
        return T.bool(prov);
      case "<": case "<=": case ">": case ">=":
        if (a.k !== "num" || b.k !== "num") { err(`Only numbers can be ordered with ${op}.`, node.span); return T.err(); }
        if (!dimEq(a.dim, b.dim)) { err(unitMsg("compare"), node.span, plainHint(a, b)); return T.err(); }
        return T.bool(prov);
      case "+": case "-": case "mod":
        if (a.k === "num" && b.k === "num") {
          if (!dimEq(a.dim, b.dim)) { err(unitMsg(op === "+" ? "add" : op === "-" ? "subtract" : "take mod of"), node.span, plainHint(a, b)); return T.err(); }
          return T.num(a.dim, prov);
        }
        if (a.k === "vec" && b.k === "vec" && op !== "mod") {
          if (a.n !== b.n) { err(`Can't combine a ${a.n}-vector with a ${b.n}-vector.`, node.span); return T.err(); }
          if (!dimEq(a.dim, b.dim)) { err(unitMsg(op === "+" ? "add" : "subtract"), node.span); return T.err(); }
          return T.vec(a.n, a.dim, prov);
        }
        err(`Can't use ${op} on ${describe(a)} and ${describe(b)}.`, node.span);
        return T.err();
      case "*":
        if (a.k === "num" && b.k === "num") return T.num(dimMul(a.dim, b.dim), prov);
        if (a.k === "vec" && b.k === "num") return T.vec(a.n, dimMul(a.dim, b.dim), prov);
        if (a.k === "num" && b.k === "vec") return T.vec(b.n, dimMul(a.dim, b.dim), prov);
        err(`Can't multiply ${describe(a)} by ${describe(b)}.`, node.span);
        return T.err();
      case "/":
        if (a.k === "num" && b.k === "num") return T.num(dimDiv(a.dim, b.dim), prov);
        if (a.k === "vec" && b.k === "num") return T.vec(a.n, dimDiv(a.dim, b.dim), prov);
        err(`Can't divide ${describe(a)} by ${describe(b)}.`, node.span);
        return T.err();
      case "^": {
        if (a.k !== "num" || b.k !== "num") { err("Only numbers can be raised to a power.", node.span); return T.err(); }
        if (!isDimless(b.dim)) { err(`A power needs a plain number, not ${describe(b)}.`, node.right.span); return T.err(); }
        if (isDimless(a.dim)) return T.num(DIMLESS, prov);
        const e = constInt(node.right);
        if (e === null) { err(`${dimName(a.dim)} can only be raised to a fixed whole number, like ^2.`, node.right.span); return T.err(); }
        return T.num(dimPow(a.dim, e), prov);
      }
    }
    err(`Unknown operator ${op}.`, node.span);
    return T.err();
  }

  function checkCall(node, ctx) {
    const { callee, args } = node;
    if (callee.type === "Member") {
      const r = member(callee, ctx, "action");
      if (!r) { args.forEach((a) => checkExpr(a.expr, ctx)); return T.err(); }
      const action = r.spec, specs = action.args ?? [];
      const full = `${r.instr}.${callee.name}`;
      const order = new Array(specs.length).fill(-1);
      let pos = 0, named = false;
      args.forEach((a, i) => {
        let slot;
        if (a.name) {
          named = true;
          slot = specs.findIndex((s) => s.name === a.name);
          if (slot < 0) { err(`${full} has no "${a.name}".`, a.nameSpan, specs.length ? `It takes: ${specs.map((s) => s.name).join(", ")}.` : `${full} takes nothing.`); return; }
        } else {
          if (named) { err("Positional values can't follow named ones.", a.expr.span); return; }
          slot = pos++;
          if (slot >= specs.length) { err(`${full} takes ${specs.length || "no"} value${specs.length === 1 ? "" : "s"}.`, a.expr.span); return; }
        }
        if (order[slot] >= 0) { err(`"${specs[slot].name}" is given twice.`, a.expr.span); return; }
        order[slot] = i;
        expectSpec(specs[slot], a.expr, ctx, `${full}'s ${specs[slot].name}`);
      });
      specs.forEach((s, i) => {
        if (order[i] < 0 && !s.optional) err(`${full} needs "${s.name}".`, node.span, `e.g. ${full}(${specs.filter((x) => !x.optional).map((x) => `${x.name}: …`).join(", ")})`);
      });
      node.r = { kind: "action", instr: r.instr, name: callee.name, order };
      return action.returns ? specType(action.returns, readProv(action.returns, env)) : T.void();
    }
    if (callee.type !== "Ident") { err("Only functions and instrument actions can be called.", callee.span); return T.err(); }
    const name = callee.name;
    for (const a of args) if (a.name && !fns.has(name)) err(`${name} takes plain values, not named ones.`, a.nameSpan);
    if (BUILTINS.has(name) && !lookupLocal(ctx, name) && !globals.has(name)) {
      const ts = args.map((a) => checkExpr(a.expr, ctx));
      if (ts.some((t) => t.k === "err")) { node.r = { kind: "builtin", name }; return T.err(); }
      let failed = false;
      const fail = (msg, i, hint) => { if (!failed) err(msg, i !== undefined && args[i] ? args[i].expr.span : node.span, hint); failed = true; };
      const t = BUILTINS.get(name).type(ts, fail, name);
      node.r = { kind: "builtin", name };
      return failed ? T.err() : t;
    }
    if (fns.has(name)) {
      const fn = fns.get(name);
      const ts = args.map((a) => checkExpr(a.expr, ctx));
      node.r = { kind: "fn", name };
      if (args.length !== fn.params.length) {
        err(`${name} takes ${fn.params.length} value${fn.params.length === 1 ? "" : "s"}, not ${args.length}.`, node.span);
        return T.err();
      }
      return checkFnBody(fn, ts, node.span);
    }
    resolveIdent(callee, ctx);
    args.forEach((a) => checkExpr(a.expr, ctx));
    return T.err();
  }

  function checkFnBody(fn, argTypes, callSpan) {
    calledFns.add(fn.name);
    if (fnStack.includes(fn.name)) {
      err(`${fn.name} calls itself. Rill has no recursion, so every tick is guaranteed to finish.`, callSpan, "Use repeat or for with a fixed count instead.");
      return T.err();
    }
    const k = fn.name + "(" + argTypes.map(typeKey).join(",") + ")";
    if (fnCache.has(k)) return fnCache.get(k);
    const scope = new Map(fn.params.map((p, i) => [p.name, { type: argTypes[i] ?? T.err() }]));
    const ctx = { scopes: [scope], fn: { name: fn.name, returns: [] }, where: "fn", depth: 1 };
    fnStack.push(fn.name);
    checkStmts(fn.body, ctx);
    fnStack.pop();
    let t = T.void();
    const rs = ctx.fn.returns;
    if (rs.length) {
      t = rs[0];
      for (const r of rs.slice(1)) {
        if (!sameType(t, r)) { err(`${fn.name} returns different kinds of value: ${describe(t)} and ${describe(r)}.`, fn.nameSpan); t = T.err(); break; }
        t = joinTypes(t, r);
      }
    }
    fnCache.set(k, t);
    return t;
  }

  // ---- statements -----------------------------------------------------------------------------
  function checkStmts(list, ctx) {
    ctx.scopes.push(new Map());
    for (const s of list) checkStmt(s, ctx);
    ctx.scopes.pop();
  }
  function checkBody(list, ctx) {
    checkStmts(list, { ...ctx, depth: ctx.depth + 1 });
  }

  function checkStmt(s, ctx) {
    if (TOP_ONLY[s.type] && ctx.depth > 0) {
      err(`"${TOP_ONLY[s.type]}" only works at the top level of a program, not inside a block.`, s.span);
      return;
    }
    switch (s.type) {
      case "Use": case "Fn": return;
      case "Seed": {
        if (s.expr.type !== "Num" || s.expr.dim) err("seed takes a plain whole number: seed 42", s.expr.span);
        else seed = (Math.floor(s.expr.value) >>> 0) || 1;
        return;
      }
      case "Let": {
        if (ctx.depth > 0 && s.isVar) {
          err("var makes state that lasts the whole program, so it belongs at the top level.", s.span, "Inside a block, use let for a working value.");
          return;
        }
        const t = checkExpr(s.expr, ctx);
        if (t.k === "void") err("This doesn't produce a value to keep.", s.expr.span);
        if (t.k === "instr") err("Instruments can't be stored in a variable; use them by name.", s.expr.span);
        if (ctx.depth === 0 && ctx.where === "setup") {
          const g = globals.get(s.name);
          if (g && g.node === s) {
            g.type = t;
            if (s.isVar) flow.varProv.set(s.name, joinProv(flow.varProv.get(s.name) ?? 0, t.prov ?? 0));
          }
          return;
        }
        if (lookupLocal(ctx, s.name) || globals.has(s.name) || reserved(s.name)) {
          err(`${s.name} already means something here; pick another name.`, s.nameSpan);
          return;
        }
        ctx.scopes[ctx.scopes.length - 1].set(s.name, { type: t });
        return;
      }
      case "Assign": return checkAssign(s, ctx);
      case "ExprStmt": {
        const t = checkExpr(s.expr, ctx);
        if (s.expr.type !== "Call" && t.k !== "err") warn("This line works out a value but doesn't use it.", s.span, "Assign it to something, e.g. scope.a = …");
        return;
      }
      case "If": {
        for (const b of s.branches) {
          const c = checkExpr(b.cond, ctx);
          if (c.k !== "bool" && c.k !== "err") err(`if needs a true/false condition, not ${describe(c)}.`, b.cond.span, c.k === "num" ? "Compare it: x > 0 m" : undefined);
          checkBody(b.body, ctx);
        }
        if (s.else) checkBody(s.else, ctx);
        return;
      }
      case "For": {
        const it = checkExpr(s.iter, ctx);
        let el = T.err();
        if (it.k === "list") el = it.of;
        else if (it.k === "vec") el = T.num(it.dim, it.prov);
        else if (it.k !== "err") err(`for walks through a list, a range or a vector, not ${describe(it)}.`, s.iter.span);
        if (lookupLocal(ctx, s.name) || globals.has(s.name) || reserved(s.name)) err(`${s.name} already means something here; pick another name.`, s.nameSpan);
        const inner = { ...ctx, depth: ctx.depth + 1 };
        inner.scopes.push(new Map([[s.name, { type: el }]]));
        checkStmts(s.body, inner);
        inner.scopes.pop();
        return;
      }
      case "Repeat": {
        const c = checkExpr(s.expr, ctx);
        if (c.k !== "err" && !(c.k === "num" && isDimless(c.dim))) err(`repeat needs a plain count, not ${describe(c)}.`, s.expr.span);
        checkBody(s.body, ctx);
        return;
      }
      case "Return": {
        if (!ctx.fn) { err("return only works inside a fn.", s.span); return; }
        ctx.fn.returns.push(s.expr ? checkExpr(s.expr, ctx) : T.void());
        return;
      }
      case "Every": case "At": {
        const t = checkExpr(s.expr, { ...ctx, where: "setup" });
        if (s.type === "Every" && s.expr.type === "Member" && s.expr.r?.kind === "event") return;
        if (t.k !== "err" && !(t.k === "num" && dimEq(t.dim, SECONDS)))
          err(`${s.type === "Every" ? "every" : "at"} needs a time, not ${describe(t)}.`, s.expr.span, "e.g. every 500 ms:  or  at 2 s:");
        checkBody(s.body, { ...ctx, where: "handler" });
        return;
      }
      case "When": {
        const t = checkExpr(s.expr, ctx);
        if (t.k !== "bool" && t.k !== "err") err(`when needs a true/false condition, not ${describe(t)}.`, s.expr.span);
        checkBody(s.body, { ...ctx, where: "handler" });
        return;
      }
      case "On": {
        if (s.expr.type !== "Member") err('on reacts to an instrument event, like "on metro.beat:"', s.expr.span);
        else member(s.expr, ctx, "event");
        checkBody(s.body, { ...ctx, where: "handler" });
        return;
      }
      case "Always":
        checkBody(s.body, { ...ctx, where: "handler" });
        return;
    }
  }

  function checkAssign(s, ctx) {
    const { target, op } = s;
    let cur;
    if (target.type === "Ident") {
      const local = lookupLocal(ctx, target.name);
      const g = globals.get(target.name);
      if (local) { err(`${target.name} was made with let, so it can't change.`, target.span, "Only top-level vars hold changing state."); checkExpr(s.expr, ctx); return; }
      if (!g) { resolveIdent(target, ctx); checkExpr(s.expr, ctx); return; }
      if (!g.isVar) { err(`${target.name} was made with let, so it can't change.`, target.span, `Declare it with var instead: var ${target.name} = …`); checkExpr(s.expr, ctx); return; }
      cur = resolveIdent(target, ctx);
      if (cur.k === "err") { checkExpr(s.expr, ctx); return; }
      const t = assignValue(cur, op, s.expr, ctx, target.name, null);
      if (t.k !== "err") flow.varProv.set(target.name, joinProv(flow.varProv.get(target.name) ?? 0, t.prov));
      return;
    }
    if (target.type === "Member") {
      const r = member(target, ctx, "write");
      if (!r) { checkExpr(s.expr, ctx); return; }
      const full = `${r.instr}.${target.name}`;
      const t = assignValue(r.type, op, s.expr, ctx, full, r.spec);
      if (t.k === "err") return;
      const k = pkey(r.instr, target.name);
      if (r.spec.type === "probe") {
        const pr = flow.probe.get(k);
        if (pr && !dimEq(pr.dim, t.dim)) {
          err(`${full} already shows ${dimName(pr.dim) || "plain numbers"}; one channel can't also show ${dimName(t.dim) || "plain numbers"}.`, s.expr.span, "Use another channel (a, b, c or d).");
          return;
        }
        flow.probe.set(k, { dim: t.dim, prov: joinProv(pr?.prov ?? 0, t.prov) });
      } else flow.paramProv.set(k, joinProv(flow.paramProv.get(k) ?? 0, t.prov));
      return;
    }
    if (target.type === "Index") {
      const o = target.object;
      if (o.type !== "Ident" || !globals.get(o.name)?.isVar) { err("Only items in a top-level var list can be changed.", target.span); checkExpr(s.expr, ctx); return; }
      const lt = checkExpr(o, ctx), it = checkExpr(target.index, ctx);
      if (it.k !== "err" && !(it.k === "num" && isDimless(it.dim))) err(`Positions are plain whole numbers, not ${describe(it)}.`, target.index.span);
      if (lt.k !== "list") { if (lt.k !== "err") err(`Only list items can be replaced, not parts of ${describe(lt)}.`, target.span); checkExpr(s.expr, ctx); return; }
      const t = assignValue(lt.of, op, s.expr, ctx, `${o.name}[…]`, null);
      if (t.k !== "err") flow.varProv.set(o.name, joinProv(flow.varProv.get(o.name) ?? 0, t.prov, it.prov ?? 0));
      return;
    }
    err("Only a var or an instrument setting can be changed.", target.span);
  }

  /** Check `target op= expr` and return the type of the value stored. */
  function assignValue(cur, op, expr, ctx, what, spec) {
    if (op === "=") {
      if (spec) return expectSpec(spec, expr, ctx, what);
      const t = checkExpr(expr, ctx);
      if (t.k === "err") return t;
      if (!sameType(cur, t)) {
        err(`${what} holds ${describe(cur)}, so it can't take ${describe(t)}.`, expr.span,
          cur.k === "num" && t.k === "num" ? `A var keeps the unit it started with (${dimName(cur.dim) || "plain"}).` : undefined);
        return T.err();
      }
      return t;
    }
    const t = checkExpr(expr, ctx);
    if (t.k === "err") return t;
    if (spec && spec.type !== "num" && spec.type !== "vec") { err(`${op} only works on numbers; ${what} is ${describe(cur)}.`, expr.span); return T.err(); }
    if (cur.k !== "num" && cur.k !== "vec") { err(`${op} only works on numbers, not ${describe(cur)}.`, expr.span); return T.err(); }
    if (op === "+=" || op === "-=") {
      if (!sameType(cur, t)) { err(`Can't ${op === "+=" ? "add" : "subtract"} ${describe(t)} ${op === "+=" ? "to" : "from"} ${what} (${describe(cur)}).`, expr.span); return T.err(); }
    } else if (t.k !== "num" || !isDimless(t.dim)) {
      err(`${op} needs a plain factor, so ${what} keeps its unit.`, expr.span);
      return T.err();
    }
    return withProv(cur, t.prov);
  }

  // ---- run ------------------------------------------------------------------------------------
  const top = { scopes: [], fn: null, where: "setup", depth: 0 };
  for (const s of ast.body) {
    if (["Every", "At", "When", "On", "Always"].includes(s.type)) handlers.push(s);
    else if (s.type === "Use" || s.type === "Fn") continue;
    else if (s.type === "Seed") checkStmt(s, top);
    else { setup.push(s); checkStmt(s, top); }
  }
  for (const h of handlers) checkStmt(h, top);
  for (const [name, fn] of fns) if (!calledFns.has(name)) checkFnBody(fn, fn.params.map(() => T.err()), fn.nameSpan);

  const errors = diagnostics.filter((d) => d.severity === "error");
  return {
    ok: errors.length === 0,
    diagnostics,
    info: {
      instruments: [...used.keys()],
      globals: [...globals].map(([name, g]) => ({
        name, isVar: g.isVar, span: g.span,
        type: g.type && g.isVar ? withProv(g.type, flow.varProv.get(name) ?? 0) : g.type,
      })),
      fns, setup, handlers, seed,
      paramProv: new Map(flow.paramProv),
      probe: new Map(flow.probe),
    },
  };
}

function constInt(node) {
  if (node.type === "Num" && !node.dim && Number.isInteger(node.value)) return node.value;
  if (node.type === "Unary" && node.op === "-") { const v = constInt(node.arg); return v === null ? null : -v; }
  return null;
}
function fmtRange(spec) {
  const s = spec.display ? spec.displayScale : 1;
  const u = spec.display ?? dimName(spec.dim);
  const f = (v) => +(v / s).toPrecision(4);
  return `${f(spec.min)} to ${f(spec.max)}${u ? " " + u : ""}`;
}
export { provName };
