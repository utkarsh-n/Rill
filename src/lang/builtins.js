// Built-in functions: a static signature (types, units, provenance) and a pure implementation.
// Implementations see only their arguments and the program's own seeded generator.

import { DIMLESS, U, dimEq, dimPow, isAngleLike, isDimless, dimName } from "./units.js";
import { P, joinProv } from "./provenance.js";
import { T, describe, withProv } from "./types.js";
import { nextFloat, noise1 } from "./rng.js";

const RAD = U("rad"), HZ = U("Hz");
const provs = (ts) => joinProv(...ts.map((t) => t.prov ?? 0));
const isNum = (t) => t.k === "num" || t.k === "err";

function arity(name, ts, n, fail) {
  if (ts.length !== n) fail(`${name} takes ${n} value${n === 1 ? "" : "s"}, not ${ts.length}.`);
}
function needNum(name, t, i, fail) {
  if (!isNum(t)) fail(`${name} needs a number here, not ${describe(t)}.`, i);
}
function sameDims(name, ts, fail) {
  const first = ts.find((t) => t.k === "num");
  ts.forEach((t, i) => {
    needNum(name, t, i, fail);
    if (first && t.k === "num" && !dimEq(t.dim, first.dim))
      fail(`${name} needs every value in the same unit: ${dimName(first.dim) || "plain"} vs ${dimName(t.dim) || "plain"}.`, i);
  });
  return first ? first.dim : DIMLESS;
}

const unary = (impl, type) => ({ type: (ts, fail, name) => (arity(name, ts, 1, fail), needNum(name, ts[0], 0, fail), type(ts[0], fail, name)), impl: ([x]) => impl(x) });
const keep = (t) => (t.k === "num" ? T.num(t.dim, t.prov) : T.err());
const plainIn = (t, fail, name) => {
  if (t.k === "num" && !isDimless(t.dim)) fail(`${name} needs a plain number, not ${describe(t)}.`, 0);
  return T.num(DIMLESS, t.prov);
};
const angleIn = (t, fail, name) => {
  if (t.k === "num" && !isAngleLike(t.dim)) fail(`${name} needs an angle or a plain number, not ${describe(t)}.`, 0, "Angles: 90 deg, 1.2 rad, 0.25 rev.");
  return T.num(DIMLESS, t.prov);
};

/** Runtime check helper: throw a plain Error; the interpreter adds the source position. */
const must = (ok, msg) => { if (!ok) throw new Error(msg); };

export const BUILTINS = new Map(Object.entries({
  sin: unary(Math.sin, angleIn),
  cos: unary(Math.cos, angleIn),
  tan: unary(Math.tan, angleIn),
  asin: unary((x) => (must(x >= -1 && x <= 1, "asin needs a value between −1 and 1."), Math.asin(x)), (t, f, n) => T.num(RAD, plainIn(t, f, n).prov)),
  acos: unary((x) => (must(x >= -1 && x <= 1, "acos needs a value between −1 and 1."), Math.acos(x)), (t, f, n) => T.num(RAD, plainIn(t, f, n).prov)),
  atan: unary(Math.atan, (t, f, n) => T.num(RAD, plainIn(t, f, n).prov)),
  atan2: {
    type: (ts, fail, name) => { arity(name, ts, 2, fail); sameDims(name, ts, fail); return T.num(RAD, provs(ts)); },
    impl: ([y, x]) => Math.atan2(y, x),
  },
  sqrt: {
    type: (ts, fail, name) => {
      arity(name, ts, 1, fail); needNum(name, ts[0], 0, fail);
      const t = ts[0];
      if (t.k !== "num") return T.err();
      if (t.dim.some((x) => x % 2 !== 0)) fail(`sqrt can't take the root of ${dimName(t.dim)}: its powers aren't even.`, 0);
      return T.num(t.dim.map((x) => x / 2), t.prov);
    },
    impl: ([x]) => (must(x >= 0, "sqrt of a negative value."), Math.sqrt(x)),
  },
  abs: unary(Math.abs, keep),
  floor: unary(Math.floor, keep),
  ceil: unary(Math.ceil, keep),
  round: unary(Math.round, keep),
  sign: unary(Math.sign, (t) => T.num(DIMLESS, t.prov)),
  exp: unary(Math.exp, plainIn),
  ln: unary((x) => (must(x > 0, "ln needs a positive value."), Math.log(x)), plainIn),
  log10: unary((x) => (must(x > 0, "log10 needs a positive value."), Math.log10(x)), plainIn),
  min: {
    type: (ts, fail, name) => listOrMany(name, ts, fail),
    impl: (args) => (args.length === 1 && Array.isArray(args[0]) ? (must(args[0].length > 0, "min of an empty list."), Math.min(...args[0])) : Math.min(...args)),
  },
  max: {
    type: (ts, fail, name) => listOrMany(name, ts, fail),
    impl: (args) => (args.length === 1 && Array.isArray(args[0]) ? (must(args[0].length > 0, "max of an empty list."), Math.max(...args[0])) : Math.max(...args)),
  },
  clamp: {
    type: (ts, fail, name) => { arity(name, ts, 3, fail); return T.num(sameDims(name, ts, fail), provs(ts)); },
    impl: ([x, lo, hi]) => Math.min(Math.max(x, lo), hi),
  },
  lerp: {
    type: (ts, fail, name) => {
      arity(name, ts, 3, fail);
      const d = sameDims(name, ts.slice(0, 2), fail);
      needNum(name, ts[2], 2, fail);
      if (ts[2]?.k === "num" && !isDimless(ts[2].dim)) fail("lerp's third value is a plain fraction, like 0.25.", 2);
      return T.num(d, provs(ts));
    },
    impl: ([a, b, f]) => a + (b - a) * f,
  },
  rand: {
    type: (ts, fail, name) => {
      if (ts.length === 0) return T.num(DIMLESS, P.set);
      arity(name, ts, 2, fail);
      return T.num(sameDims(name, ts, fail), provs(ts));
    },
    impl: (args, rt) => {
      const u = nextFloat(rt.rng);
      return args.length ? args[0] + (args[1] - args[0]) * u : u;
    },
  },
  noise: {
    type: (ts, fail, name) => (arity(name, ts, 1, fail), plainIn(ts[0], fail, name)),
    impl: ([x], rt) => noise1(x, rt.seed),
  },
  midi: {
    type: (ts, fail, name) => (arity(name, ts, 1, fail), T.num(HZ, plainIn(ts[0], fail, name).prov)),
    impl: ([n]) => 440 * Math.pow(2, (n - 69) / 12),
  },
  len: {
    type: (ts, fail, name) => {
      arity(name, ts, 1, fail);
      const t = ts[0];
      if (t && t.k !== "list" && t.k !== "vec" && t.k !== "err") fail(`len needs a list or a vector, not ${describe(t)}.`, 0);
      return T.num(DIMLESS, P.set);
    },
    impl: ([xs]) => xs.length,
  },
  sum: {
    type: (ts, fail, name) => listOf(name, ts, fail),
    impl: ([xs]) => xs.reduce((a, b) => a + b, 0),
  },
  mean: {
    type: (ts, fail, name) => listOf(name, ts, fail),
    impl: ([xs]) => (must(xs.length > 0, "mean of an empty list."), xs.reduce((a, b) => a + b, 0) / xs.length),
  },
  mag: {
    type: (ts, fail, name) => {
      arity(name, ts, 1, fail);
      const t = ts[0];
      if (t?.k === "vec") return T.num(t.dim, t.prov);
      if (t?.k !== "err") fail(`mag needs a vector, not ${describe(t)}.`, 0);
      return T.err();
    },
    impl: ([v]) => Math.hypot(...v),
  },
  illustrative: {
    type: (ts, fail, name) => (arity(name, ts, 1, fail), withProv(ts[0] ?? T.err(), P.illustrative)),
    impl: ([x]) => x,
    doc: "Marks a value as a display choice. Provenance only ever gets more cautious.",
  },
  simulated: {
    type: (ts, fail, name) => (arity(name, ts, 1, fail), withProv(ts[0] ?? T.err(), P.simulated)),
    impl: ([x]) => x,
  },
}));

function listOrMany(name, ts, fail) {
  if (ts.length === 1 && ts[0].k === "list") return listOf(name, ts, fail);
  if (ts.length < 1) fail(`${name} needs at least one value.`);
  return T.num(sameDims(name, ts, fail), provs(ts));
}
function listOf(name, ts, fail) {
  arity(name, ts, 1, fail);
  const t = ts[0];
  if (t?.k === "list" && t.of.k === "num") return T.num(t.of.dim, t.of.prov);
  if (t?.k !== "err") fail(`${name} needs a list of numbers, not ${describe(t)}.`, 0);
  return T.err();
}

/** Named constants. `t` and `dt` are the program clock (see world.js). */
export const CONSTANTS = new Map([
  ["π", { type: T.num(DIMLESS), value: Math.PI }],
  ["pi", { type: T.num(DIMLESS), value: Math.PI }],
  ["τ", { type: T.num(DIMLESS), value: 2 * Math.PI }],
  ["tau", { type: T.num(DIMLESS), value: 2 * Math.PI }],
]);
export const CLOCK = new Map([
  ["t", T.num(U("s"))],
  ["dt", T.num(U("s"))],
]);

export { dimPow };
