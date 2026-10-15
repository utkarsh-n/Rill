// Rill interpreter. Walks the checked AST; it can only reach what the checker resolved: locals,
// top-level state, built-ins, and the instrument hooks the world hands it. Every tick has a fuel
// budget, so no program can hold the page.

import { BUILTINS } from "./builtins.js";

export const FUEL_PER_TICK = 200_000;
export const MAX_LIST = 4096;

export class Fault extends Error {
  constructor(message, span, kind = "runtime") {
    super(message);
    this.span = span ? { start: span.start, end: span.end, line: span.line, col: span.col } : null;
    this.kind = kind;
  }
}

const isVec = Array.isArray;

export class Machine {
  /**
   * @param info checker output `info`
   * @param hooks { getParam(i,n), setParam(i,n,v,span), read(i,n), act(i,n,args), clock: {t, dt} }
   */
  constructor(info, hooks) {
    this.info = info;
    this.hooks = hooks;
    this.globals = new Map();
    this.rng = { s: 1 };
    this.seed = info.seed;
    this.fuel = FUEL_PER_TICK;
    this.halted = null;
    this.hstate = info.handlers.map(() => ({}));
  }

  // ---- state ----------------------------------------------------------------------------------
  snapshot() {
    return structuredClone({ globals: [...this.globals], hstate: this.hstate, rng: this.rng, halted: this.halted && { message: this.halted.message, span: this.halted.span, kind: this.halted.kind } });
  }
  restore(s) {
    const c = structuredClone(s);
    this.globals = new Map(c.globals);
    this.hstate = c.hstate;
    this.rng = c.rng;
    this.halted = c.halted ? new Fault(c.halted.message, c.halted.span, c.halted.kind) : null;
  }

  // ---- lifecycle ------------------------------------------------------------------------------
  /** Run the top-level statements once, at t = 0. */
  setup() {
    this.guard(() => {
      this.execList(this.info.setup, null);
      this.info.handlers.forEach((h, i) => {
        const st = this.hstate[i];
        if (h.type === "Every") {
          const iv = this.eval(h.expr, null);
          if (!(iv > 0)) throw new Fault("every needs a time longer than zero.", h.expr.span);
          st.interval = iv;
          st.next = iv;
        } else if (h.type === "At") {
          st.time = this.eval(h.expr, null);
          st.done = false;
        } else if (h.type === "When") st.prev = false;
      });
    });
  }

  /**
   * One tick at program time t.
   * @param events [{instr, name}] raised by instruments during the previous step
   */
  tick(t, events) {
    if (this.halted) return;
    this.guard(() => {
      const hs = this.info.handlers;
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i];
        if (h.type !== "On") continue;
        const r = h.expr.r;
        for (const e of events) if (e.instr === r.instr && e.name === r.name) this.execList(h.body, []);
      }
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i], st = this.hstate[i];
        if (h.type === "Every") {
          let n = 0;
          while (t + 1e-9 >= st.next && n < 8) { this.execList(h.body, []); st.next += st.interval; n++; }
          if (t + 1e-9 >= st.next) st.next = t + st.interval; // skip a backlog rather than burst
        } else if (h.type === "At") {
          if (!st.done && t + 1e-9 >= st.time) { st.done = true; this.execList(h.body, []); }
        }
      }
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i];
        if (h.type !== "When") continue;
        const now = this.eval(h.expr, []);
        const st = this.hstate[i];
        if (now && !st.prev) this.execList(h.body, []);
        st.prev = now;
      }
      for (const h of hs) if (h.type === "Always") this.execList(h.body, []);
    });
  }

  guard(fn) {
    this.fuel = FUEL_PER_TICK;
    try {
      fn();
    } catch (e) {
      if (e instanceof Fault) this.halted = e;
      else this.halted = new Fault(`Internal error: ${e.message}`, null, "internal");
    }
  }

  burn(span) {
    if (--this.fuel < 0)
      throw new Fault("This tick ran out of steps, so the program stopped. Something loops far more than it needs to.", span, "fuel");
  }

  // ---- statements -----------------------------------------------------------------------------
  /** scopes === null means top level: let/var write program state. */
  execList(list, scopes) {
    const inner = scopes === null ? null : [...scopes, new Map()];
    for (const s of list) {
      const r = this.exec(s, inner);
      if (r) return r;
    }
    return undefined;
  }

  exec(s, scopes) {
    this.burn(s.span);
    switch (s.type) {
      case "Let": {
        const v = this.eval(s.expr, scopes);
        if (scopes === null) this.globals.set(s.name, v);
        else scopes[scopes.length - 1].set(s.name, v);
        return;
      }
      case "Assign": return this.assign(s, scopes);
      case "ExprStmt": this.eval(s.expr, scopes); return;
      case "If": {
        for (const b of s.branches) if (this.eval(b.cond, scopes)) return this.execList(b.body, scopes ?? []);
        if (s.else) return this.execList(s.else, scopes ?? []);
        return;
      }
      case "For": {
        const it = this.eval(s.iter, scopes);
        const base = scopes ?? [];
        for (const x of it.slice()) {
          const r = this.execList(s.body, [...base, new Map([[s.name, x]])]);
          if (r) return r;
        }
        return;
      }
      case "Repeat": {
        const n = this.eval(s.expr, scopes);
        if (!Number.isFinite(n) || n < 0) throw new Fault("repeat needs a count of zero or more.", s.expr.span);
        for (let i = 0; i < Math.floor(n); i++) {
          const r = this.execList(s.body, scopes ?? []);
          if (r) return r;
        }
        return;
      }
      case "Return": return { value: s.expr ? this.eval(s.expr, scopes) : undefined };
      default: return;
    }
  }

  assign(s, scopes) {
    const { target, op } = s;
    let v = this.eval(s.expr, scopes);
    const combine = (cur) => {
      if (op === "=") return v;
      if (op === "+=") return isVec(cur) ? cur.map((x, i) => x + v[i]) : cur + v;
      if (op === "-=") return isVec(cur) ? cur.map((x, i) => x - v[i]) : cur - v;
      if (op === "*=") return isVec(cur) ? cur.map((x) => x * v) : cur * v;
      if (v === 0) throw new Fault("Divided by zero.", s.expr.span);
      return isVec(cur) ? cur.map((x) => x / v) : cur / v;
    };
    if (target.type === "Ident") {
      const cur = this.globals.get(target.name);
      this.globals.set(target.name, combine(cur));
      return;
    }
    if (target.type === "Member") {
      const r = target.r;
      const cur = op === "=" ? undefined : this.hooks.getParam(r.instr, r.name);
      this.hooks.setParam(r.instr, r.name, combine(cur), s.span);
      return;
    }
    if (target.type === "Index") {
      const name = target.object.name;
      const list = this.globals.get(name);
      const i = this.index(this.eval(target.index, scopes), list.length, target.index.span);
      const copy = list.slice();
      copy[i] = combine(list[i]);
      this.globals.set(name, copy);
    }
  }

  index(i, n, span) {
    if (!Number.isInteger(i)) throw new Fault(`Positions are whole numbers; got ${i}.`, span);
    const j = i < 0 ? n + i : i;
    if (j < 0 || j >= n) throw new Fault(`Position ${i} is outside a list of ${n}. Positions start at 0.`, span);
    return j;
  }

  // ---- expressions ----------------------------------------------------------------------------
  lookup(name, scopes, span) {
    if (scopes) for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name);
    if (this.globals.has(name)) return this.globals.get(name);
    throw new Fault(`${name} is used before its line has run.`, span);
  }

  eval(node, scopes) {
    this.burn(node.span);
    switch (node.type) {
      case "Num": return node.value;
      case "Bool": return node.value;
      case "Ident": {
        const r = node.r;
        switch (r?.kind) {
          case "local": case "global": return this.lookup(node.name, scopes, node.span);
          case "clock": return this.hooks.clock[r.name];
          case "const": case "literal": return r.value;
          default: throw new Fault(`${node.name} can't be used here.`, node.span);
        }
      }
      case "Unary": {
        const v = this.eval(node.arg, scopes);
        if (node.op === "not") return !v;
        return isVec(v) ? v.map((x) => -x) : -v;
      }
      case "Binary": return this.binary(node, scopes);
      case "IfExpr": return this.eval(node.cond, scopes) ? this.eval(node.then, scopes) : this.eval(node.else, scopes);
      case "Tuple": return node.items.map((n) => this.eval(n, scopes));
      case "List": return node.items.map((n) => this.eval(n, scopes));
      case "Range": {
        const a = this.eval(node.from, scopes), b = this.eval(node.to, scopes);
        if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Fault(`Ranges count whole numbers; got ${a}..${b}.`, node.span);
        if (b - a + 1 > MAX_LIST) throw new Fault(`That range has ${b - a + 1} numbers; the limit is ${MAX_LIST}.`, node.span);
        const out = [];
        for (let i = a; i <= b; i++) out.push(i);
        return out;
      }
      case "Member": {
        const r = node.r;
        if (r.kind === "comp") return this.eval(node.object, scopes)[r.i];
        if (r.kind === "param") return this.hooks.getParam(r.instr, r.name);
        if (r.kind === "read") return this.hooks.read(r.instr, r.name);
        throw new Fault(`${r.instr}.${r.name} can't be used as a value.`, node.span);
      }
      case "Index": {
        const o = this.eval(node.object, scopes);
        return o[this.index(this.eval(node.index, scopes), o.length, node.index.span)];
      }
      case "Call": return this.call(node, scopes);
    }
    throw new Fault("This can't be evaluated.", node.span, "internal");
  }

  binary(node, scopes) {
    const { op } = node;
    if (op === "and") return this.eval(node.left, scopes) && this.eval(node.right, scopes);
    if (op === "or") return this.eval(node.left, scopes) || this.eval(node.right, scopes);
    const a = this.eval(node.left, scopes), b = this.eval(node.right, scopes);
    switch (op) {
      case "==": return isVec(a) ? a.every((x, i) => x === b[i]) : a === b;
      case "!=": return isVec(a) ? !a.every((x, i) => x === b[i]) : a !== b;
      case "<": return a < b;
      case "<=": return a <= b;
      case ">": return a > b;
      case ">=": return a >= b;
      case "+": return isVec(a) ? a.map((x, i) => x + b[i]) : a + b;
      case "-": return isVec(a) ? a.map((x, i) => x - b[i]) : a - b;
      case "*":
        if (isVec(a)) return a.map((x) => x * b);
        if (isVec(b)) return b.map((x) => a * x);
        return a * b;
      case "/":
        if (b === 0) throw new Fault("Divided by zero.", node.right.span);
        return isVec(a) ? a.map((x) => x / b) : a / b;
      case "mod":
        if (b === 0) throw new Fault("mod by zero.", node.right.span);
        return a - b * Math.floor(a / b);
      case "^": {
        const v = Math.pow(a, b);
        if (Number.isNaN(v)) throw new Fault(`${a} ^ ${b} has no real value.`, node.span);
        return v;
      }
    }
    throw new Fault(`Unknown operator ${op}.`, node.span, "internal");
  }

  call(node, scopes) {
    const r = node.r;
    if (r.kind === "builtin") {
      const args = node.args.map((a) => this.eval(a.expr, scopes));
      try {
        const v = BUILTINS.get(r.name).impl(args, this);
        if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`${r.name} gave ${v}.`);
        return v;
      } catch (e) {
        throw new Fault(e.message, node.span);
      }
    }
    if (r.kind === "fn") {
      const fn = this.info.fns.get(r.name);
      const frame = new Map(fn.params.map((p, i) => [p.name, this.eval(node.args[i].expr, scopes)]));
      const out = this.execList(fn.body, [frame]);
      return out ? out.value : undefined;
    }
    if (r.kind === "action") {
      const args = r.order.map((i) => (i >= 0 ? this.eval(node.args[i].expr, scopes) : undefined));
      return this.hooks.act(r.instr, r.name, args, node.span);
    }
    throw new Fault("This can't be called.", node.span, "internal");
  }
}
