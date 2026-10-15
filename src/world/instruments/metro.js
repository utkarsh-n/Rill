// metro: a metronome clock. The beat is exact: phase advances by tempo × dt each tick, so a beat
// lands on the tick where the phase wraps (within one tick, 16.7 ms, of the ideal time).

export default {
  name: "metro",
  title: "Metronome",
  fig: 3,
  doc: "A beat clock. React to it with on metro.beat: and on metro.bar:",
  params: {
    tempo: { type: "num", unit: "Hz", display: "bpm", min: 20, max: 300, default: 96, doc: "Beats per minute." },
    meter: { type: "num", unit: "", min: 1, max: 12, default: 4, integer: true, doc: "Beats in a bar; beat 1 is accented." },
    running: { type: "bool", default: true, doc: "Stop and start the clock." },
  },
  reads: {
    beat: { type: "num", unit: "", prov: "set", doc: "Beats counted so far." },
    phase: { type: "num", unit: "", prov: "set", doc: "How far through the current beat, 0 to 1." },
  },
  actions: {
    reset: { doc: "Start counting again from beat 0.", args: [] },
  },
  events: {
    beat: { doc: "Every beat." },
    bar: { doc: "The first beat of every bar." },
  },

  init() {
    return { phase: 0, beat: 0 };
  },
  step(s, p, dt, io) {
    if (!p.running) return;
    s.phase += p.tempo * dt;
    while (s.phase >= 1) {
      s.phase -= 1;
      const accent = s.beat % p.meter === 0;
      s.beat++;
      io.emit("beat");
      if (accent) io.emit("bar");
      io.sound({ kind: "click", accent });
    }
  },
  act(s, p, name) {
    if (name === "reset") { s.phase = 0; s.beat = 0; }
  },
  read(s, p, name) {
    return name === "beat" ? s.beat : s.phase;
  },
  render(s, p) {
    return { phase: s.phase, beat: s.beat, meter: p.meter, bpm: p.tempo * 60, running: p.running };
  },
};
