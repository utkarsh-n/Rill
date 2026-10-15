// tone: one plucked voice. The world models its envelope; the page's audio engine plays it only
// when the viewer has turned sound on.

export default {
  name: "tone",
  title: "Tone",
  fig: 4,
  doc: "A plucked voice. tone.pluck() sounds it; settings shape the next pluck.",
  params: {
    freq: { type: "num", unit: "Hz", min: 20, max: 5000, default: 220, doc: "Pitch of the next pluck." },
    level: { type: "num", unit: "", min: 0, max: 1, default: 0.5, doc: "Loudness, 0 to 1." },
    decay: { type: "num", unit: "s", min: 0.02, max: 6, default: 0.8, doc: "Time for the sound to fall to 37%." },
    wave: { type: "enum", values: ["sine", "triangle", "saw", "square"], default: "triangle", doc: "Timbre." },
  },
  reads: {
    env: { type: "num", unit: "", prov: "modelled", doc: "Current loudness envelope, 0 to 1." },
    plucks: { type: "num", unit: "", prov: "set", doc: "Plucks so far." },
  },
  actions: {
    pluck: {
      doc: "Sound the voice, optionally at another pitch.",
      args: [
        { name: "freq", type: "num", unit: "Hz", min: 20, max: 5000, optional: true },
        { name: "level", type: "num", unit: "", min: 0, max: 1, optional: true },
      ],
    },
  },
  events: {},

  init() {
    return { env: 0, last: 220, plucks: 0, trail: [] };
  },
  step(s, p, dt) {
    s.env *= Math.exp(-dt / p.decay);
    if (s.env < 1e-4) s.env = 0;
  },
  act(s, p, name, [freq, level], io) {
    const f = Math.min(5000, Math.max(20, freq ?? p.freq));
    const l = Math.min(1, Math.max(0, level ?? p.level));
    s.env = l;
    s.last = f;
    s.plucks++;
    s.trail.push({ t: io.t, f, l });
    if (s.trail.length > 24) s.trail.shift();
    io.sound({ kind: "pluck", freq: f, level: l, decay: p.decay, wave: p.wave });
  },
  read(s, p, name) {
    return name === "env" ? s.env : s.plucks;
  },
  render(s, p, io) {
    return { env: s.env, freq: s.last, wave: p.wave, decay: p.decay, t: io.t, trail: s.trail.slice() };
  },
};
