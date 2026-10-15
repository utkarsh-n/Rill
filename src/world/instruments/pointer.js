// pointer: where the viewer is pointing on the stage, as fractions of its width and height
// (y measured up). Touch and mouse are live input.

export default {
  name: "pointer",
  title: "Pointer",
  card: false,
  doc: "Your mouse or finger over the stage: pointer.x, pointer.y (0 to 1), pointer.down.",
  params: {},
  reads: {
    x: { type: "num", unit: "", prov: "live", doc: "0 at the left edge of the stage, 1 at the right." },
    y: { type: "num", unit: "", prov: "live", doc: "0 at the bottom of the stage, 1 at the top." },
    down: { type: "bool", prov: "live", doc: "Pressed." },
  },
  actions: {},
  events: {
    press: { doc: "Pressed." },
    release: { doc: "Let go." },
  },

  init() {
    return { x: 0.5, y: 0.5, down: false };
  },
  step(s, p, dt, io) {
    const g = io.stage;
    if (!g) return;
    if (g.down && !s.down) io.emit("press");
    if (!g.down && s.down) io.emit("release");
    s.x = g.x; s.y = g.y; s.down = g.down;
  },
  act() {},
  read(s, p, name) {
    return s[name];
  },
  render(s) {
    return { ...s };
  },
};
