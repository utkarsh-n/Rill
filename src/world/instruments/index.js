// The instruments a Rill program can put on the page. Each manifest declares what a program may
// touch (settings, readings, actions, events) with units and ranges; nothing else is reachable.

import { U, unitScale } from "../../lang/units.js";
import metro from "./metro.js";
import tone from "./tone.js";
import pendulum from "./pendulum.js";
import tank from "./tank.js";
import scope from "./scope.js";
import pointer from "./pointer.js";
import tilt from "./tilt.js";

/**
 * Fill in SI dims and scales. Manifests write numbers in their `display` unit when they have one
 * (tempo in bpm), otherwise in `unit`; the world always works in SI.
 */
function compileSpec(spec) {
  const s = { ...spec };
  if (s.type === "num" || s.type === "vec") {
    s.dim = U(s.unit ?? "");
    const unitK = unitScale(s.unit ?? "");
    s.displayScale = s.display ? unitScale(s.display) : unitK;
    const k = s.display ? s.displayScale : unitK;
    for (const f of ["min", "max", "default"]) if (typeof s[f] === "number") s[f] *= k;
    if (Array.isArray(s.default)) s.default = s.default.map((v) => v * k);
    if (s.presets) s.presets = Object.fromEntries(Object.entries(s.presets).map(([n, v]) => [n, v * k]));
  }
  return s;
}
const mapSpecs = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, compileSpec(v)]));

export function compileManifest(m) {
  return {
    ...m,
    params: mapSpecs(m.params),
    reads: mapSpecs(m.reads),
    actions: Object.fromEntries(Object.entries(m.actions ?? {}).map(([k, a]) => [k, { ...a, args: (a.args ?? []).map(compileSpec), returns: a.returns && compileSpec(a.returns) }])),
    events: m.events ?? {},
  };
}

export const REGISTRY = new Map([tank, pendulum, metro, tone, scope, tilt, pointer].map((m) => [m.name, compileManifest(m)]));

/** The parts of the registry the editor needs (no functions): names, docs, units, ranges. */
export function describeRegistry(registry = REGISTRY) {
  const plain = (o) => Object.fromEntries(Object.entries(o).map(([k, s]) => [k, {
    type: s.type, unit: s.unit, display: s.display, min: s.min, max: s.max, displayScale: s.displayScale,
    values: s.values, presets: s.presets && Object.keys(s.presets), doc: s.doc,
    prov: typeof s.prov === "function" ? "live or simulated" : s.prov,
  }]));
  return [...registry.values()].map((m) => ({
    name: m.name, title: m.title, fig: m.fig, doc: m.doc, card: m.card !== false,
    params: plain(m.params), reads: plain(m.reads),
    actions: Object.fromEntries(Object.entries(m.actions).map(([k, a]) => [k, { doc: a.doc, args: a.args.map((x) => ({ name: x.name, type: x.type, unit: x.display ?? x.unit, optional: !!x.optional })) }])),
    events: Object.fromEntries(Object.entries(m.events).map(([k, e]) => [k, { doc: e.doc }])),
  }));
}
