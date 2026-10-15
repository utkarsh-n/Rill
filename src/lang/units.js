// Dimensions and units. Every Rill number carries a dimension, checked before the program runs.
// Values are stored in SI; a unit only scales a literal on the way in and a readout on the way out.

/** Base dimensions, in vector order. `rad` is tracked so angles can't silently become frequencies. */
export const BASES = ["m", "kg", "s", "A", "K", "mol", "cd", "rad"];
const N = BASES.length;

export const DIMLESS = Object.freeze(new Array(N).fill(0));
export const dimKey = (d) => d.join(",");
export const dimEq = (a, b) => a.every((x, i) => x === b[i]);
export const dimMul = (a, b) => a.map((x, i) => x + b[i]);
export const dimDiv = (a, b) => a.map((x, i) => x - b[i]);
export const dimPow = (a, n) => a.map((x) => x * n);
export const isDimless = (d) => d.every((x) => x === 0);
/** Accepted by sin/cos/tan: plain numbers or radians to the first power. */
export const isAngleLike = (d) => d.every((x, i) => (i === 7 ? x === 0 || x === 1 : x === 0));

const D = (o = {}) => BASES.map((b) => o[b] || 0);

// ---- unit atoms -------------------------------------------------------------------------------

const PREFIX = { G: 1e9, M: 1e6, k: 1e3, h: 1e2, c: 1e-2, m: 1e-3, "µ": 1e-6, u: 1e-6, n: 1e-9 };

/** name → { scale (to SI), dim, offset? }. Built once from base atoms and their allowed prefixes. */
export const ATOMS = new Map();
function atom(name, scale, dim, prefixes = "", offset = 0) {
  ATOMS.set(name, { scale, dim, offset });
  for (const p of prefixes) ATOMS.set(p + name, { scale: scale * PREFIX[p], dim, offset });
}
const LEN = D({ m: 1 }), MASS = D({ kg: 1 }), TIME = D({ s: 1 }), FREQ = D({ s: -1 });
const FORCE = D({ kg: 1, m: 1, s: -2 }), ENERGY = D({ kg: 1, m: 2, s: -2 }), POWER = D({ kg: 1, m: 2, s: -3 });
atom("m", 1, LEN, "kcmµun");
atom("g", 1e-3, MASS, "kmµu");
atom("s", 1, TIME, "mµun");
atom("min", 60, TIME);
atom("h", 3600, TIME);
atom("Hz", 1, FREQ, "kMG");
atom("bpm", 1 / 60, FREQ);
atom("N", 1, FORCE, "km");
atom("J", 1, ENERGY, "kmM");
atom("W", 1, POWER, "kmMG");
atom("Pa", 1, D({ kg: 1, m: -1, s: -2 }), "khM");
atom("A", 1, D({ A: 1 }), "mµu");
atom("V", 1, D({ kg: 1, m: 2, s: -3, A: -1 }), "kmµu");
atom("Ω", 1, D({ kg: 1, m: 2, s: -3, A: -2 }), "kM");
atom("ohm", 1, D({ kg: 1, m: 2, s: -3, A: -2 }), "kM");
atom("C", 1, D({ A: 1, s: 1 }), "mµun");
atom("K", 1, D({ K: 1 }), "m");
atom("°C", 1, D({ K: 1 }), "", 273.15);
atom("mol", 1, D({ mol: 1 }), "mµ");
atom("cd", 1, D({ cd: 1 }));
atom("L", 1e-3, D({ m: 3 }), "m");
atom("rad", 1, D({ rad: 1 }), "m");
atom("deg", Math.PI / 180, D({ rad: 1 }));
atom("°", Math.PI / 180, D({ rad: 1 }));
atom("rev", 2 * Math.PI, D({ rad: 1 }));
atom("rpm", (2 * Math.PI) / 60, D({ rad: 1, s: -1 }));
atom("%", 0.01, D());

const SUPER = { "⁰": 0, "¹": 1, "²": 2, "³": 3, "⁴": 4, "⁵": 5, "⁶": 6, "⁷": 7, "⁸": 8, "⁹": 9 };
const isAtomChar = (c) => c !== undefined && /[A-Za-zµΩ°%]/u.test(c);

/**
 * Scan the longest unit expression starting at `src[i]`. Grammar (no spaces inside):
 *   unit := term (('/' | '·' | '*') term)*      term := atom (('^' '-'? digits) | superscripts)?
 * Returns { end, scale, dim, offset, text } or null when no atom starts here.
 * An affine unit (°C) is only accepted on its own, never inside a compound.
 */
export function scanUnit(src, i) {
  let j = i, end = i, scale = 1, dim = DIMLESS.slice(), offset = 0, terms = 0, sign = 1;
  for (;;) {
    let k = j;
    while (isAtomChar(src[k])) k++;
    const name = src.slice(j, k);
    const a = ATOMS.get(name);
    if (!a) break;
    // An atom must not run straight into a digit or underscore (that would be an identifier).
    if (/[0-9_]/.test(src[k] ?? "")) break;
    let exp = 1, p = k;
    if (src[p] === "^") {
      let q = p + 1, neg = false;
      if (src[q] === "-") { neg = true; q++; }
      const s = q;
      while (/[0-9]/.test(src[q] ?? "")) q++;
      if (q > s) { exp = (neg ? -1 : 1) * Number(src.slice(s, q)); p = q; }
    } else {
      let q = p, neg = false;
      if (src[q] === "⁻") { neg = true; q++; }
      const s = q;
      while (src[q] in SUPER) q++;
      if (q > s) {
        exp = (neg ? -1 : 1) * Number([...src.slice(s, q)].map((c) => SUPER[c]).join(""));
        p = q;
      }
    }
    if (a.offset && (terms > 0 || exp !== 1)) return null;
    scale *= Math.pow(a.scale, sign * exp);
    dim = dimMul(dim, dimPow(a.dim, sign * exp));
    offset = a.offset;
    terms++;
    j = end = p;
    const op = src[j];
    if ((op === "/" || op === "·" || op === "*") && isAtomChar(src[j + 1])) {
      if (offset) return null;
      sign = op === "/" ? -1 : 1;
      j++;
      continue;
    }
    break;
  }
  if (!terms) return null;
  // A "/" or "*" that didn't start a valid term belongs to the expression, not the unit.
  return { end, scale, dim, offset, text: src.slice(i, end) };
}

/** Parse a whole unit string, for manifests and tests: U("m/s^2"). Throws on failure. */
export function U(text) {
  if (text === "" || text === "1") return DIMLESS.slice();
  const r = scanUnit(text, 0);
  if (!r || r.end !== text.length) throw new Error(`unknown unit "${text}"`);
  return r.dim;
}
/** Scale of a unit string to SI: unitScale("bpm") = 1/60. */
export function unitScale(text) {
  if (text === "" || text === "1") return 1;
  const r = scanUnit(text, 0);
  if (!r || r.end !== text.length) throw new Error(`unknown unit "${text}"`);
  return r.scale;
}

// ---- display ----------------------------------------------------------------------------------

/** Named units for common dimensions, tried before falling back to base symbols. */
const NAMED = new Map(
  [
    ["", D()], ["m", LEN], ["kg", MASS], ["s", TIME], ["Hz", FREQ], ["N", FORCE], ["J", ENERGY],
    ["W", POWER], ["Pa", D({ kg: 1, m: -1, s: -2 })], ["V", D({ kg: 1, m: 2, s: -3, A: -1 })],
    ["A", D({ A: 1 })], ["Ω", D({ kg: 1, m: 2, s: -3, A: -2 })], ["C", D({ A: 1, s: 1 })],
    ["K", D({ K: 1 })], ["rad", D({ rad: 1 })], ["rad/s", D({ rad: 1, s: -1 })],
    ["rad/s²", D({ rad: 1, s: -2 })], ["m/s", D({ m: 1, s: -1 })], ["m/s²", D({ m: 1, s: -2 })],
    ["J/kg", D({ m: 2, s: -2 })], ["m²", D({ m: 2 })], ["m³", D({ m: 3 })], ["N·m", ENERGY],
  ].map(([n, d]) => [dimKey(d), n]),
);
// J and N·m share a dimension; prefer J.
NAMED.set(dimKey(ENERGY), "J");

const SUP_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n) => (n < 0 ? "⁻" : "") + String(Math.abs(n)).split("").map((c) => SUP_DIGITS[c]).join("");

/** "m/s²", "kg·m²·s⁻³·A⁻¹", or "" for a plain number. */
export function dimName(d) {
  const named = NAMED.get(dimKey(d));
  if (named !== undefined) return named;
  const parts = [];
  BASES.forEach((b, i) => {
    if (d[i] === 0) return;
    parts.push(d[i] === 1 ? b : b + sup(d[i]));
  });
  return parts.join("·");
}

const ENG = [
  [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"],
];
const PREFIXABLE = new Set(["m", "s", "Hz", "N", "J", "W", "Pa", "V", "A", "Ω", "C"]);

/** Format a number to `sig` significant figures without exponent noise. */
export function fmtNum(v, sig = 4) {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? "NaN" : v > 0 ? "∞" : "−∞";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(sig - 1).replace("-", "−");
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(a)));
  let s = v.toFixed(Math.min(digits, 6));
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s.replace("-", "−");
}

/**
 * Format an SI value with its dimension: fmtQ(0.012, U("m")) → "12 mm".
 * `display` forces a unit (e.g. "bpm" for a tempo); it must match the dimension.
 */
export function fmtQ(v, d, display) {
  if (display) {
    const s = unitScale(display);
    return `${fmtNum(v / s)} ${display}`;
  }
  const name = dimName(d);
  if (name === "") return fmtNum(v);
  if (PREFIXABLE.has(name) && v !== 0 && Number.isFinite(v)) {
    const a = Math.abs(v);
    for (const [s, p] of ENG) {
      if (a >= s * 0.9995) return `${fmtNum(v / s)} ${p}${name}`;
    }
    return `${fmtNum(v / 1e-9)} n${name}`;
  }
  return `${fmtNum(v)} ${name}`;
}
