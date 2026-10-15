// Where a value comes from. LabKit's vocabulary (measured, modelled, live, simulated, illustrative)
// plus `set` for values the author typed. Provenance is part of a value's static type: combining
// values keeps the most cautionary source, so a readout can never look surer than its inputs.

/** Ordered from least to most cautionary. The join of two sources is the later one. */
export const PROV = ["set", "measured", "live", "modelled", "simulated", "illustrative"];
export const P = Object.freeze(Object.fromEntries(PROV.map((n, i) => [n, i])));

export const joinProv = (...ps) => Math.max(0, ...ps);
export const provName = (p) => PROV[p] ?? "set";

export const PROV_EXPLAIN = {
  set: "Typed by the author, or derived only from typed values.",
  measured: "Interpolated from published measurements.",
  live: "Read from this device's sensors or your touch as you watch.",
  modelled: "Calculated by a physical model. Trust its shape more than its third digit.",
  simulated: "A stand-in for a sensor this device doesn't have or hasn't allowed.",
  illustrative: "A display choice to make an effect visible, not a quantity.",
};
