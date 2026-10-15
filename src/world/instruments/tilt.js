// tilt: which way is down. On a phone that allows motion access it reads the accelerometer (live);
// anywhere else you drag the bubble, and the readings are honestly marked simulated.

const prov = (env) => (env.motion ? "live" : "simulated");

export default {
  name: "tilt",
  title: "Tilt",
  fig: 6,
  doc: "Gravity across the screen. tilt.x and tilt.y run from −1 to 1; tilt.roll is an angle.",
  params: {},
  reads: {
    x: { type: "num", unit: "", prov, doc: "Sideways share of gravity, −1 (left) to 1 (right)." },
    y: { type: "num", unit: "", prov, doc: "Up-down share of gravity in the screen plane, −1 to 1." },
    roll: { type: "num", unit: "rad", prov, doc: "Sideways tilt angle." },
  },
  actions: {},
  events: {},

  init() {
    return { x: 0, y: 0 };
  },
  step(s, p, dt, io) {
    if (io.tilt && io.tilt.source === "motion") {
      s.x = io.tilt.x; s.y = io.tilt.y;
    } else if (io.input && io.input.down) {
      let x = (io.input.lx - 0.5) * 2, y = (io.input.ly - 0.5) * 2;
      const r = Math.hypot(x, y);
      if (r > 1) { x /= r; y /= r; }
      s.x = x; s.y = y;
    }
  },
  act() {},
  read(s, p, name) {
    if (name === "roll") return Math.asin(Math.max(-1, Math.min(1, s.x)));
    return s[name];
  },
  render(s, p, io) {
    return { x: s.x, y: s.y, source: io.tilt?.source ?? "touch" };
  },
};
