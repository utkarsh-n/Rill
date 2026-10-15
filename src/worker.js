// The sandbox. Rill programs run here and only here: a worker has no DOM, and below we remove every
// way out it would otherwise have (network, storage, nested workers). The page talks to it with
// plain-data messages and never executes anything a program wrote.
//
// Layers, outermost first:
//   1. The page serves this file with its own Content-Security-Policy (connect-src 'none').
//   2. This worker deletes network/storage globals before handling any message.
//   3. The language has no strings, no eval, no way to name a JavaScript object: the checker only
//      resolves names to Rill locals, Rill state, built-ins and instrument manifests.
//   4. Every tick has a fuel budget, and the page restarts the worker if it ever stops answering.

import { compile } from "./lang/compile.js";
import { REGISTRY } from "./world/instruments/index.js";
import { World } from "./world/world.js";

const post = self.postMessage.bind(self);
for (const k of [
  "fetch", "XMLHttpRequest", "WebSocket", "WebTransport", "EventSource", "importScripts", "indexedDB",
  "caches", "BroadcastChannel", "Worker", "SharedWorker", "Request", "Response", "FileReader",
]) {
  try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch { /* already gone */ }
}

let world = null;
let lastOk = null;

function send(type, payload) {
  const transfer = [];
  if (payload?.frame) for (const inst of payload.frame.instruments) {
    for (const v of Object.values(inst.data)) if (ArrayBuffer.isView(v)) transfer.push(v.buffer);
    if (inst.data.buf) for (const b of inst.data.buf) transfer.push(b.buffer);
  }
  post({ type, ...payload }, transfer);
}

function frame() {
  return { frame: world.frame(), sounds: world.takeSounds() };
}

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "load": {
        const c = compile(String(msg.source ?? ""), { registry: REGISTRY, env: { motion: !!msg.env?.motion } });
        if (c.ok) {
          world = new World(c, { registry: REGISTRY, env: { motion: !!msg.env?.motion } });
          lastOk = msg.source;
        }
        send("compiled", {
          id: msg.id,
          ok: c.ok,
          diagnostics: c.diagnostics,
          running: !!world,
          ...(c.ok ? frame() : {}),
        });
        return;
      }
      case "advance": {
        if (!world) return send("frame", { id: msg.id, frame: null });
        const n = Math.max(0, Math.min(8, msg.n | 0));
        world.advance(n, msg.input ?? null, { interacting: !!msg.interacting, silent: !!msg.silent });
        return send("frame", { id: msg.id, ...frame() });
      }
      case "seek": {
        if (!world) return;
        world.seek(Number(msg.tick) || 0);
        world.takeSounds();
        return send("frame", { id: msg.id, ...frame() });
      }
    }
  } catch (e) {
    send("crash", { id: msg.id, message: String(e?.message ?? e), lastOk });
  }
};

post({ type: "ready" });
