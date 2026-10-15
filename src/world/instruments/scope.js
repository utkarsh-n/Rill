// scope: a four-channel plotter. Any quantity can be sent to a channel; the channel shows the
// unit and provenance the checker worked out for it, so a plot never claims more than its source.

const LEN = 600; // 10 s of history at 60 ticks/s

export default {
  name: "scope",
  title: "Scope",
  fig: 5,
  doc: "Plot anything over time: scope.a = pendulum.angle. Channels a, b, c, d.",
  params: {
    a: { type: "probe", doc: "Channel a (cyan)." },
    b: { type: "probe", doc: "Channel b (amber)." },
    c: { type: "probe", doc: "Channel c (violet)." },
    d: { type: "probe", doc: "Channel d (mint)." },
    window: { type: "num", unit: "s", min: 1, max: 10, default: 6, doc: "How much history is shown." },
  },
  reads: {},
  actions: { clear: { doc: "Wipe the traces.", args: [] } },
  events: {},

  init() {
    return { buf: [0, 1, 2, 3].map(() => new Float32Array(LEN)), n: 0, head: 0, seen: [false, false, false, false] };
  },
  step(s, p, dt, io) {
    ["a", "b", "c", "d"].forEach((k, i) => {
      s.buf[i][s.head] = p[k];
      if (io.written(k)) s.seen[i] = true;
    });
    s.head = (s.head + 1) % LEN;
    s.n = Math.min(LEN, s.n + 1);
  },
  act(s) {
    s.n = 0;
  },
  read() { return 0; },
  render(s, p) {
    return { buf: s.buf.map((b) => b.slice()), n: s.n, head: s.head, seen: s.seen.slice(), window: p.window, len: LEN };
  },
};
