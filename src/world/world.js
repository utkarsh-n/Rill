// The world: instruments plus one running program, advanced on a fixed 60 Hz clock.
//
// Everything that happens is a function of (program, seed, inputs). Inputs are logged per tick and
// the whole state is snapshotted every SNAP ticks, so any moment in the last minute can be
// restored exactly: rewind, step, scrub. Playing on from the past replays the logged inputs;
// touching the stage there starts a new branch.

import { Machine, Fault } from "../lang/interp.js";
import { fmtQ, fmtNum, dimName } from "../lang/units.js";
import { P, joinProv, provName } from "../lang/provenance.js";
import { specType } from "../lang/checker.js";

export const DT = 1 / 60;
export const SNAP = 30;
export const KEEP = 3600; // ticks of history (60 s)

const NO_INPUT = Object.freeze({ stage: null, cards: {}, tilt: null });

export class World {
  /**
   * @param compiled result of compile(): { info }
   * @param opts { registry, env }
   */
  constructor(compiled, { registry, env = {} }) {
    this.info = compiled.info;
    this.registry = registry;
    this.env = env;
    this.tick = 0;
    this.head = 0;
    this.base = 0;
    this.snaps = new Map();
    this.inputs = new Map();
    this.pending = [];
    this.sounds = [];
    this.notices = new Map();
    this.clock = { t: 0, dt: DT };
    this.io = null;

    this.instr = new Map();
    for (const name of this.info.instruments) {
      const m = registry.get(name);
      const params = {};
      for (const [k, s] of Object.entries(m.params)) params[k] = s.type === "probe" ? 0 : structuredClone(s.default);
      this.instr.set(name, { m, params, requested: {}, state: m.init({ params, seed: this.info.seed }) });
    }

    const world = this;
    this.machine = new Machine(this.info, {
      clock: this.clock,
      getParam: (i, n) => world.instr.get(i).params[n],
      setParam: (i, n, v, span) => world.setParam(i, n, v, span),
      read: (i, n) => {
        const it = world.instr.get(i);
        return it.m.read(it.state, it.params, n, world.ioFor(i));
      },
      act: (i, n, args, span) => {
        const it = world.instr.get(i);
        const spec = it.m.actions[n];
        spec.args.forEach((a, k) => {
          if (args[k] === undefined) return;
          if (!finite(args[k])) throw new Fault(`${i}.${n}'s ${a.name} isn't a finite number.`, span);
        });
        return it.m.act(it.state, it.params, n, args, world.ioFor(i));
      },
    });
    this.machine.rng = { s: this.info.seed >>> 0 || 1 };
    this.machine.seed = this.info.seed;
    this.input = NO_INPUT;
    this.machine.setup();
    this.snaps.set(0, this.snapshot());
  }

  // ---- settings -------------------------------------------------------------------------------
  setParam(i, n, v, span) {
    const it = this.instr.get(i);
    const spec = it.m.params[n];
    if (!finite(v)) throw new Fault(`${i}.${n} can't be set to ${Array.isArray(v) ? `(${v.join(", ")})` : v}.`, span);
    let accepted = v;
    if (spec.type === "num") {
      accepted = Math.min(spec.max, Math.max(spec.min, v));
      if (spec.integer) accepted = Math.round(accepted);
    } else if (spec.type === "vec" && Number.isFinite(spec.min)) {
      accepted = v.map((x) => Math.min(spec.max, Math.max(spec.min, x)));
    }
    it.params[n] = accepted;
    // Keep what was asked for when it differs from what the instrument accepted.
    if (accepted !== v && !(Array.isArray(v) && v.every((x, k) => x === accepted[k]))) it.requested[n] = v;
    else delete it.requested[n];
  }

  ioFor(name) {
    const world = this;
    return {
      t: this.clock.t,
      env: this.env,
      input: this.input.cards?.[name] ?? null,
      stage: this.input.stage,
      tilt: this.input.tilt,
      emit: (event) => world.pending.push({ instr: name, name: event }),
      sound: (s) => world.sounds.push({ ...s, instr: name, tick: world.tick }),
      written: (param) => world.info.probe.has(`${name}.${param}`),
    };
  }

  // ---- time -----------------------------------------------------------------------------------
  /** One fixed step. Events raised while stepping are delivered to the program next tick. */
  step(input) {
    this.input = input ?? NO_INPUT;
    this.clock.t = this.tick * DT;
    const events = this.pending;
    this.pending = [];
    this.machine.tick(this.clock.t, events);
    for (const [name, it] of this.instr) it.m.step(it.state, it.params, DT, this.ioFor(name));
    this.tick++;
    this.clock.t = this.tick * DT;
  }

  /**
   * Advance n ticks. While behind the head, logged inputs replay; at the head, `live` is used.
   * @param interacting the viewer touched the stage this frame (branches history if in the past)
   */
  advance(n, live, { interacting = false, silent = false } = {}) {
    if (interacting && this.tick < this.head) this.branch();
    const start = this.sounds.length;
    for (let k = 0; k < n; k++) {
      const replay = this.tick < this.head;
      const input = replay ? this.inputs.get(this.tick) ?? NO_INPUT : live ?? NO_INPUT;
      if (!replay) this.inputs.set(this.tick, input);
      this.step(input);
      if (this.tick > this.head) {
        this.head = this.tick;
        if (this.tick % SNAP === 0) this.snaps.set(this.tick, this.snapshot());
        this.trim();
      }
    }
    if (silent) this.sounds.length = start;
  }

  /** Forget the future after the current tick: the viewer changed something in the past. */
  branch() {
    for (const k of this.snaps.keys()) if (k > this.tick) this.snaps.delete(k);
    for (const k of this.inputs.keys()) if (k >= this.tick) this.inputs.delete(k);
    this.head = this.tick;
  }

  trim() {
    const floor = this.head - KEEP;
    if (floor <= this.base) return;
    for (const k of this.snaps.keys()) if (k < floor) this.snaps.delete(k);
    this.base = Math.min(...this.snaps.keys());
    for (const k of this.inputs.keys()) if (k < this.base) this.inputs.delete(k);
  }

  /** Jump to any tick in [base, head]: restore the snapshot at or before it, then replay. */
  seek(target) {
    target = Math.max(this.base, Math.min(this.head, Math.round(target)));
    let best = this.base;
    for (const k of this.snaps.keys()) if (k <= target && k > best) best = k;
    this.restore(this.snaps.get(best));
    const n = target - this.tick;
    if (n > 0) this.advance(n, null, { silent: true });
  }

  snapshot() {
    const instr = {};
    for (const [name, it] of this.instr) instr[name] = { params: it.params, requested: it.requested, state: it.state };
    return { tick: this.tick, machine: this.machine.snapshot(), instr: structuredClone(instr), pending: structuredClone(this.pending) };
  }
  restore(s) {
    this.tick = s.tick;
    this.clock.t = s.tick * DT;
    this.machine.restore(s.machine);
    const c = structuredClone(s.instr);
    for (const [name, it] of this.instr) Object.assign(it, c[name]);
    this.pending = structuredClone(s.pending);
  }

  // ---- what the page shows --------------------------------------------------------------------
  takeSounds() {
    const s = this.sounds;
    this.sounds = [];
    return s;
  }

  /** Everything the renderer and inspector need, as plain data (strings are formatted here). */
  frame() {
    const instruments = [];
    for (const [name, it] of this.instr) {
      if (it.m.card === false) continue;
      const data = it.m.render(it.state, it.params, this.ioFor(name));
      if (name === "scope") data.channels = this.channelLabels();
      instruments.push({ name, title: it.m.title, fig: it.m.fig, data });
    }
    const vars = this.info.globals.filter((g) => g.type).map((g) => ({
      name: g.name,
      isVar: g.isVar,
      value: this.machine.globals.has(g.name) ? fmtValue(this.machine.globals.get(g.name), g.type) : "—",
      prov: provName(g.type.prov ?? 0),
    }));
    const settings = [];
    for (const [name, it] of this.instr) {
      const rows = [];
      for (const [k, spec] of Object.entries(it.m.params)) {
        let type, prov;
        if (spec.type === "probe") {
          const pr = this.info.probe.get(`${name}.${k}`);
          if (!pr) continue;
          type = { k: "num", dim: pr.dim };
          prov = pr.prov;
        } else {
          prov = this.info.paramProv.get(`${name}.${k}`) ?? P.set;
          type = specType(spec, prov);
        }
        rows.push({
          name: k, kind: "setting", value: fmtValue(it.params[k], type, spec.display), prov: provName(prov),
          requested: Object.hasOwn(it.requested, k) ? fmtValue(it.requested[k], type, spec.display) : null,
        });
      }
      for (const [k, spec] of Object.entries(it.m.reads)) {
        const prov = P[typeof spec.prov === "function" ? spec.prov(this.env) : spec.prov ?? "modelled"];
        const v = it.m.read(it.state, it.params, k, this.ioFor(name));
        rows.push({ name: k, kind: "reading", value: fmtValue(v, specType(spec, prov), spec.display), prov: provName(prov) });
      }
      settings.push({ name, title: it.m.title, rows });
    }
    const h = this.machine.halted;
    return {
      tick: this.tick, t: this.tick * DT, head: this.head, base: this.base, live: this.tick === this.head,
      halted: h ? { message: h.message, span: h.span, kind: h.kind } : null,
      instruments, vars, settings,
    };
  }

  channelLabels() {
    const out = {};
    for (const k of ["a", "b", "c", "d"]) {
      const pr = this.info.probe.get(`scope.${k}`);
      if (pr) out[k] = { unit: dimName(pr.dim), prov: provName(pr.prov) };
    }
    return out;
  }

  /** A stable fingerprint of the whole state, for determinism tests. */
  fingerprint() {
    const h = { v: 2166136261 };
    const mix = (x) => {
      const s = typeof x === "number" ? x.toPrecision(12) : String(x);
      for (let i = 0; i < s.length; i++) h.v = Math.imul(h.v ^ s.charCodeAt(i), 16777619) >>> 0;
    };
    const walk = (o) => {
      if (o === null || o === undefined) return mix("∅");
      if (ArrayBuffer.isView(o) || Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (typeof o === "object") { for (const k of Object.keys(o).sort()) { mix(k); walk(o[k]); } return; }
      mix(o);
    };
    walk(this.snapshot());
    return h.v.toString(16);
  }
}

function finite(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => typeof x !== "number" || Number.isFinite(x));
  return true;
}

export function fmtValue(v, type, display) {
  if (v === undefined) return "—";
  switch (type?.k) {
    case "num": return typeof v === "number" ? fmtQ(v, type.dim, display) : String(v);
    case "bool": return v ? "true" : "false";
    case "enum": return String(v);
    case "vec": {
      const u = display ?? dimName(type.dim);
      const k = display ? null : 1;
      return `(${v.map((x) => (k ? fmtNum(x) : fmtQ(x, type.dim, display).split(" ")[0])).join(", ")})${u ? " " + u : ""}`;
    }
    case "list": {
      const items = v.slice(0, 8).map((x) => fmtValue(x, type.of));
      return `[${items.join(", ")}${v.length > 8 ? `, … ${v.length - 8} more` : ""}]`;
    }
    default: return String(v);
  }
}

export { joinProv };
