// tank: a 2D particle fluid after Clavet, Beaudoin & Poulin (2005), "Particle-based viscoelastic
// fluid simulation": double-density relaxation for pressure and near-pressure (surface tension),
// pairwise radial viscosity impulses. The non-Newtonian materials make that viscosity depend on a
// local shear rate: ketchup thins under shear, oobleck thickens until it jams.
//
// This is a toy model with honest labels: readings are `modelled`, the material constants are
// chosen to show each behaviour, not fitted to rheometer data. (Rheo's MPM solver is the real one.)

const W = 1, H = 0.62;          // tank in simulation units
const SCALE = 0.3;              // metres per unit: the tank is 30 cm wide
const NUM = 720;                // particles
const R = 0.05;                 // interaction radius
const SUB = 2;                  // substeps per tick
const K = 60, K_NEAR = 160;     // pressure stiffness
const VMAX = 4;                 // speed cap, units/s (stability)
const GX = Math.ceil(W / R), GY = Math.ceil(H / R) + 2;

/** Viscosity (σ, linear term, 1/s) as a function of local shear rate γ (1/s). */
export const MATERIALS = {
  water: { sigma: () => 0.4, beta: 0.4, tint: [0.32, 0.86, 1.0] },
  honey: { sigma: () => 26, beta: 0, tint: [1.0, 0.68, 0.18] },
  ketchup: { sigma: (g) => 34 / (1 + g / 1.6), beta: 0.2, tint: [0.92, 0.16, 0.12] },
  oobleck: { sigma: (g) => Math.min(120, 1.2 * (1 + (g / 3.2) ** 3)), beta: 0.2, tint: [0.92, 0.92, 0.82], jams: true },
};
const SIGMA_JAM = 60;

function rho0() {
  // Rest density of a triangular lattice at the spacing init() uses.
  const sp = 0.0215;
  let d = 0;
  for (let i = -4; i <= 4; i++)
    for (let j = -4; j <= 4; j++) {
      const x = (i + (j & 1) * 0.5) * sp, y = j * sp * 0.866;
      const q = Math.hypot(x, y) / R;
      if (q < 1 && (i || j)) d += (1 - q) * (1 - q);
    }
  return d;
}
const RHO0 = rho0();

function makeGrid() {
  return { start: new Int32Array(GX * GY + 1), cell: new Int32Array(NUM), order: new Int32Array(NUM) };
}
function buildGrid(g, x, y) {
  g.start.fill(0);
  for (let i = 0; i < NUM; i++) {
    const cx = Math.min(GX - 1, Math.max(0, (x[i] / R) | 0));
    const cy = Math.min(GY - 1, Math.max(0, (y[i] / R) | 0));
    const c = cy * GX + cx;
    g.cell[i] = c;
    g.start[c + 1]++;
  }
  for (let c = 0; c < GX * GY; c++) g.start[c + 1] += g.start[c];
  const fill = g.start.slice(0, GX * GY);
  for (let i = 0; i < NUM; i++) g.order[fill[g.cell[i]]++] = i;
}
/** Call f(j) for every particle j in the 3×3 cells around particle i (j ≠ i). */
function forNear(g, i, f) {
  const c = g.cell[i], cx = c % GX, cy = (c / GX) | 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= GY) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = cx + dx;
      if (xx < 0 || xx >= GX) continue;
      const cc = yy * GX + xx;
      for (let k = g.start[cc]; k < g.start[cc + 1]; k++) {
        const j = g.order[k];
        if (j !== i) f(j);
      }
    }
  }
}

// Scratch space, rebuilt every substep; never part of the (snapshotted) state.
const GRID = makeGrid(), PX = new Float64Array(NUM), PY = new Float64Array(NUM);

function fill(s) {
  const sp = 0.0215, cols = Math.floor((W - 0.04) / sp);
  for (let i = 0; i < NUM; i++) {
    const row = Math.floor(i / cols), col = i % cols;
    s.x[i] = 0.02 + col * sp + (row & 1) * sp * 0.5;
    s.y[i] = 0.015 + row * sp * 0.866;
    s.vx[i] = s.vy[i] = s.gam[i] = 0;
  }
}

export default {
  name: "tank",
  title: "Tank",
  fig: 1,
  doc: "A 30 cm glass tank of fluid. Drag through it, poke it, change what's in it.",
  params: {
    material: { type: "enum", values: Object.keys(MATERIALS), default: "water", doc: "What's in the tank." },
    gravity: {
      type: "num", unit: "m/s^2", min: 0, max: 30, default: 9.80665, doc: "Local gravity.",
      presets: { earth: 9.80665, moon: 1.62, mars: 3.71, jupiter: 24.79, zero: 0 },
    },
    tilt: { type: "num", unit: "rad", min: -0.6, max: 0.6, default: 0, doc: "Which way gravity leans." },
  },
  reads: {
    shear: { type: "num", unit: "s^-1", prov: "modelled", doc: "Average shear rate in the fluid." },
    energy: { type: "num", unit: "J/kg", prov: "modelled", doc: "Kinetic energy per kilogram." },
    level: { type: "num", unit: "", prov: "modelled", doc: "How full the tank looks, 0 to 1." },
    jammed: { type: "bool", prov: "modelled", doc: "Oobleck has locked solid." },
  },
  actions: {
    poke: {
      doc: "Shove the fluid near a point. at: (0,0) is bottom left, (1,1) top right.",
      args: [
        { name: "at", type: "vec", n: 2, unit: "", min: 0, max: 1 },
        { name: "push", type: "vec", n: 2, unit: "m/s" },
        { name: "size", type: "num", unit: "", min: 0.02, max: 0.5, optional: true },
      ],
    },
    refill: { doc: "Pour the tank out and fill it again, at rest.", args: [] },
  },
  events: {
    jam: { doc: "Oobleck locks solid." },
    flow: { doc: "Oobleck lets go and flows again." },
  },

  init() {
    const s = {
      x: new Float64Array(NUM), y: new Float64Array(NUM), vx: new Float64Array(NUM), vy: new Float64Array(NUM),
      gam: new Float64Array(NUM), jammed: false, jamFrac: 0, last: null,
    };
    fill(s);
    return s;
  },

  step(s, p, dt, io) {
    const m = MATERIALS[p.material] ?? MATERIALS.water;
    const h = dt / SUB;
    const gs = p.gravity / SCALE;
    const gx = gs * Math.sin(p.tilt), gy = -gs * Math.cos(p.tilt);
    const { x, y, vx, vy, gam } = s;
    const g = GRID, px = PX, py = PY;

    // Direct manipulation: drag through the fluid.
    const inp = io.input;
    if (inp && inp.down) {
      const cx = inp.lx * W, cy = inp.ly * H;
      if (s.last) {
        const ux = (cx - s.last[0]) / dt, uy = (cy - s.last[1]) / dt;
        for (let i = 0; i < NUM; i++) {
          const d = Math.hypot(x[i] - cx, y[i] - cy);
          if (d < 0.09) {
            const w = 0.35 * (1 - d / 0.09);
            vx[i] += (ux - vx[i]) * w;
            vy[i] += (uy - vy[i]) * w;
          }
        }
      }
      s.last = [cx, cy];
    } else s.last = null;

    let jamCount = 0;
    for (let sub = 0; sub < SUB; sub++) {
      // 1. gravity
      for (let i = 0; i < NUM; i++) { vx[i] += gx * h; vy[i] += gy * h; }
      // 2. viscosity impulses between approaching neighbours
      buildGrid(g, x, y);
      for (let i = 0; i < NUM; i++) {
        forNear(g, i, (j) => {
          if (j < i) return;
          const dx = x[j] - x[i], dy = y[j] - y[i];
          const r = Math.hypot(dx, dy);
          if (r >= R || r < 1e-9) return;
          const nx = dx / r, ny = dy / r;
          const u = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny;
          if (u <= 0) return;
          const q = r / R;
          const sig = m.sigma(0.5 * (gam[i] + gam[j]));
          let imp = h * (1 - q) * (sig * u + m.beta * u * u);
          if (imp > u * 0.5) imp = u * 0.5; // never reverse an approach
          vx[i] -= imp * nx * 0.5; vy[i] -= imp * ny * 0.5;
          vx[j] += imp * nx * 0.5; vy[j] += imp * ny * 0.5;
        });
      }
      // 3. advance, remembering where each particle was
      for (let i = 0; i < NUM; i++) {
        const sp = Math.hypot(vx[i], vy[i]);
        if (sp > VMAX) { vx[i] *= VMAX / sp; vy[i] *= VMAX / sp; }
        px[i] = x[i]; py[i] = y[i];
        x[i] += vx[i] * h; y[i] += vy[i] * h;
      }
      // 4. double density relaxation
      buildGrid(g, x, y);
      const h2 = h * h;
      for (let i = 0; i < NUM; i++) {
        let rho = 0, near = 0;
        forNear(g, i, (j) => {
          const q = Math.hypot(x[j] - x[i], y[j] - y[i]) / R;
          if (q < 1) { const a = 1 - q; rho += a * a; near += a * a * a; }
        });
        const P = K * (rho - RHO0), Pn = K_NEAR * near;
        let dxi = 0, dyi = 0;
        forNear(g, i, (j) => {
          const dx = x[j] - x[i], dy = y[j] - y[i];
          const r = Math.hypot(dx, dy);
          if (r >= R || r < 1e-9) return;
          const a = 1 - r / R;
          let D = h2 * (P * a + Pn * a * a);
          if (D > R * 0.25) D = R * 0.25;
          const ux = (dx / r) * D * 0.5, uy = (dy / r) * D * 0.5;
          x[j] += ux; y[j] += uy;
          dxi -= ux; dyi -= uy;
        });
        x[i] += dxi; y[i] += dyi;
      }
      // 5. walls (the lid is open: particles may splash up to 1.5 H)
      const e = 0.004;
      for (let i = 0; i < NUM; i++) {
        if (x[i] < e) x[i] = e;
        if (x[i] > W - e) x[i] = W - e;
        if (y[i] < e) y[i] = e;
        if (y[i] > H * 1.5) y[i] = H * 1.5;
      }
      // 6. velocities from motion
      for (let i = 0; i < NUM; i++) { vx[i] = (x[i] - px[i]) / h; vy[i] = (y[i] - py[i]) / h; }
      // 7. local shear rate for next substep's viscosity
      buildGrid(g, x, y);
      jamCount = 0;
      for (let i = 0; i < NUM; i++) {
        let sum = 0, wsum = 0;
        forNear(g, i, (j) => {
          const q = Math.hypot(x[j] - x[i], y[j] - y[i]) / R;
          if (q >= 1) return;
          const w = 1 - q;
          sum += w * Math.hypot(vx[i] - vx[j], vy[i] - vy[j]);
          wsum += w;
        });
        gam[i] = wsum > 0 ? sum / wsum / R : 0;
        if (m.jams && m.sigma(gam[i]) > SIGMA_JAM) jamCount++;
      }
    }
    // Jamming with hysteresis, so it doesn't flicker at the threshold.
    s.jamFrac = jamCount / NUM;
    const was = s.jammed;
    if (!m.jams) s.jammed = false;
    else if (!s.jammed && s.jamFrac > 0.12) s.jammed = true;
    else if (s.jammed && s.jamFrac < 0.05) s.jammed = false;
    if (s.jammed && !was) io.emit("jam");
    if (!s.jammed && was) io.emit("flow");
  },

  act(s, p, name, args) {
    if (name === "refill") { fill(s); s.jammed = false; return; }
    const [at, push, size] = args;
    const cx = Math.min(1, Math.max(0, at[0])) * W, cy = Math.min(1, Math.max(0, at[1])) * H;
    const rad = (size ?? 0.12) * W;
    const ux = push[0] / SCALE, uy = push[1] / SCALE;
    for (let i = 0; i < NUM; i++) {
      const d = Math.hypot(s.x[i] - cx, s.y[i] - cy);
      if (d < rad) {
        const w = 1 - d / rad;
        s.vx[i] += ux * w;
        s.vy[i] += uy * w;
      }
    }
  },

  read(s, p, name) {
    switch (name) {
      case "shear": { let a = 0; for (let i = 0; i < NUM; i++) a += s.gam[i]; return a / NUM; }
      case "energy": {
        let e = 0;
        for (let i = 0; i < NUM; i++) e += s.vx[i] * s.vx[i] + s.vy[i] * s.vy[i];
        return (0.5 * e * SCALE * SCALE) / NUM;
      }
      case "level": { let a = 0; for (let i = 0; i < NUM; i++) a += s.y[i]; return Math.min(1, (2 * a) / NUM / H); }
      default: return s.jammed;
    }
  },

  render(s, p) {
    const m = MATERIALS[p.material] ?? MATERIALS.water;
    const pos = new Float32Array(NUM * 2), heat = new Float32Array(NUM);
    for (let i = 0; i < NUM; i++) {
      pos[2 * i] = s.x[i] / W;
      pos[2 * i + 1] = s.y[i] / H;
      heat[i] = Math.min(1, m.sigma(s.gam[i]) / (m.jams ? SIGMA_JAM : 40) * (m.jams ? 1 : 0.3) + Math.min(1, s.gam[i] / 30) * 0.4);
    }
    return { pos, heat, n: NUM, material: p.material, tint: m.tint, jammed: s.jammed, aspect: H / W, tilt: p.tilt };
  },
};
