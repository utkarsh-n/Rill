// Static types. Every type carries a provenance (see provenance.js) next to its dimension.

import { DIMLESS, dimEq, dimName } from "./units.js";
import { joinProv, provName } from "./provenance.js";

export const T = {
  num: (dim = DIMLESS, prov = 0) => ({ k: "num", dim, prov }),
  bool: (prov = 0) => ({ k: "bool", prov }),
  vec: (n, dim = DIMLESS, prov = 0) => ({ k: "vec", n, dim, prov }),
  list: (of) => ({ k: "list", of, prov: of.prov }),
  enm: (values, prov = 0) => ({ k: "enum", values, prov }),
  instr: (name) => ({ k: "instr", name, prov: 0 }),
  void: () => ({ k: "void", prov: 0 }),
  /** Already reported; anything goes so one mistake doesn't cascade. */
  err: () => ({ k: "err", prov: 0 }),
};

export const withProv = (t, prov) => {
  if (t.k === "list") return T.list(withProv(t.of, joinProv(t.of.prov, prov)));
  return { ...t, prov: joinProv(t.prov, prov) };
};

/** Same shape and dimension, ignoring provenance. */
export function sameType(a, b) {
  if (a.k === "err" || b.k === "err") return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "num": return dimEq(a.dim, b.dim);
    case "vec": return a.n === b.n && dimEq(a.dim, b.dim);
    case "list": return sameType(a.of, b.of);
    case "enum": return a.values.join() === b.values.join();
    case "instr": return a.name === b.name;
    default: return true;
  }
}

export function joinTypes(a, b) {
  if (a.k === "err") return b;
  if (b.k === "err") return a;
  return withProv(a, b.prov);
}

/** Human description for error messages: "a number in m/s²", "a 2-vector in m/s", "true/false". */
export function describe(t) {
  switch (t.k) {
    case "num": { const u = dimName(t.dim); return u ? `a quantity in ${u}` : "a plain number"; }
    case "bool": return "true/false";
    case "vec": { const u = dimName(t.dim); return `a ${t.n}-vector${u ? " in " + u : ""}`; }
    case "list": return `a list of ${describe(t.of).replace(/^an? /, "")}s`;
    case "enum": return `one of ${t.values.join(", ")}`;
    case "instr": return `the instrument ${t.name}`;
    case "void": return "nothing";
    default: return "something";
  }
}

/** Compact key for caching function bodies checked against argument types. */
export function typeKey(t) {
  switch (t.k) {
    case "num": return `n${t.dim.join(".")}p${t.prov}`;
    case "vec": return `v${t.n}:${t.dim.join(".")}p${t.prov}`;
    case "list": return `l(${typeKey(t.of)})`;
    case "enum": return `e(${t.values.join("|")})p${t.prov}`;
    case "bool": return `bp${t.prov}`;
    default: return t.k;
  }
}

export const provOf = (t) => provName(t.prov ?? 0);
