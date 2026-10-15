// Deterministic randomness. The generator's whole state is one 32-bit integer, so it snapshots and
// replays exactly: the same program, seed and inputs always produce the same world.

export function makeRng(seed = 1) {
  return { s: seed >>> 0 || 0x9e3779b9 };
}

/** mulberry32: uniform in [0, 1). Mutates `rng.s`. */
export function nextFloat(rng) {
  let a = (rng.s = (rng.s + 0x6d2b79f5) >>> 0);
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

function hash(i, seed) {
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [−1, 1]; depends only on x and the program seed, never on call order. */
export function noise1(x, seed) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash(i, seed), b = hash(i + 1, seed);
  return (a + (b - a) * u) * 2 - 1;
}
