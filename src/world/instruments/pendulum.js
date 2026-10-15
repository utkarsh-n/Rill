// pendulum: a damped, driven simple pendulum, θ'' = −(g/L) sin θ − c θ' + A cos(2π f t),
// integrated with RK4 at four substeps per tick. With drive on it can turn chaotic.

const SUB = 4;

function deriv(th, om, t, p) {
  return [om, -(p.gravity / p.length) * Math.sin(th) - p.damping * om + p.drive * Math.cos(2 * Math.PI * p.driveFreq * t)];
}

export default {
  name: "pendulum",
  title: "Pendulum",
  fig: 2,
  doc: "A weight on a light rod. Drag the bob to swing it.",
  params: {
    length: { type: "num", unit: "m", min: 0.05, max: 5, default: 1, doc: "Rod length." },
    gravity: {
      type: "num", unit: "m/s^2", min: 0, max: 30, default: 9.80665, doc: "Local gravity.",
      presets: { earth: 9.80665, moon: 1.62, mars: 3.71, jupiter: 24.79, zero: 0 },
    },
    damping: { type: "num", unit: "s^-1", min: 0, max: 5, default: 0.08, doc: "Friction; 0 swings forever." },
    drive: { type: "num", unit: "rad/s^2", min: 0, max: 40, default: 0, doc: "Strength of a periodic push." },
    driveFreq: { type: "num", unit: "Hz", min: 0, max: 3, default: 0.6, doc: "How often the push repeats." },
  },
  reads: {
    angle: { type: "num", unit: "rad", prov: "modelled", doc: "Angle from straight down." },
    omega: { type: "num", unit: "rad/s", prov: "modelled", doc: "Angular velocity." },
    energy: { type: "num", unit: "J/kg", prov: "modelled", doc: "Energy per kilogram of bob." },
    period: { type: "num", unit: "s", prov: "modelled", doc: "Small-swing period 2π√(L/g)." },
  },
  actions: {
    push: { doc: "Change the swing speed.", args: [{ name: "by", type: "num", unit: "rad/s" }] },
    hold: { doc: "Hold the bob at an angle, at rest.", args: [{ name: "angle", type: "num", unit: "rad" }] },
  },
  events: {
    swing: { doc: "The bob passes its lowest point." },
  },

  init() {
    return { th: 0.6, om: 0, trail: [], held: false, lastAngle: 0 };
  },
  step(s, p, dt, io) {
    const inp = io.input;
    const prev = s.th;
    if (inp && inp.down) {
      // Grab: the bob follows the pointer around the pivot (pivot at the card's top centre).
      const target = Math.atan2(inp.lx - 0.5, 0.86 - inp.ly);
      let d = target - s.th;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      s.om = d / dt;
      s.th += d;
      s.held = true;
    } else {
      if (s.held) { s.held = false; s.om = Math.max(-30, Math.min(30, s.om * 0.5)); }
      const h = dt / SUB;
      for (let k = 0; k < SUB; k++) {
        const t = io.t + k * h;
        const [a1, b1] = deriv(s.th, s.om, t, p);
        const [a2, b2] = deriv(s.th + (h / 2) * a1, s.om + (h / 2) * b1, t + h / 2, p);
        const [a3, b3] = deriv(s.th + (h / 2) * a2, s.om + (h / 2) * b2, t + h / 2, p);
        const [a4, b4] = deriv(s.th + h * a3, s.om + h * b3, t + h, p);
        s.th += (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
        s.om += (h / 6) * (b1 + 2 * b2 + 2 * b3 + b4);
      }
    }
    // Lowest point: the angle (wrapped) crosses zero while not held.
    const w = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    if (!s.held && Math.sign(w(prev)) !== Math.sign(w(s.th)) && Math.abs(w(prev)) < 1.5 && w(s.th) !== 0) io.emit("swing");
    s.trail.push([Math.sin(s.th) * p.length, -Math.cos(s.th) * p.length]);
    if (s.trail.length > 90) s.trail.shift();
  },
  act(s, p, name, [v]) {
    if (name === "push") s.om += v;
    else { s.th = v; s.om = 0; }
  },
  read(s, p, name) {
    switch (name) {
      case "angle": return Math.atan2(Math.sin(s.th), Math.cos(s.th));
      case "omega": return s.om;
      case "energy": return 0.5 * p.length * p.length * s.om * s.om + p.gravity * p.length * (1 - Math.cos(s.th));
      default: return p.gravity > 0 ? 2 * Math.PI * Math.sqrt(p.length / p.gravity) : Infinity;
    }
  },
  render(s, p) {
    return { th: s.th, om: s.om, length: p.length, trail: s.trail.slice(), held: s.held, drive: p.drive };
  },
};
