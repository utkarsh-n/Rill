// Rill dev server: static files, strict security headers, live reload. Loopback only.
import http from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const root = import.meta.dirname;
const port = Number(process.env.PORT || 3470);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".png": "image/png",
};

// The page may talk only to itself. The worker that runs programs may talk to nothing at all.
const PAGE_CSP = "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";
const WORKER_CSP = "default-src 'none'; script-src 'self'";

const clients = new Set();
let previous = "";
async function fingerprint() {
  const files = ["public/index.html", "public/rill.css",
    ...(await readdir(resolve(root, "src"), { recursive: true })).filter((f) => f.endsWith(".js")).map((f) => "src/" + f)];
  return (await Promise.all(files.map(async (f) => (await stat(resolve(root, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs))).join(",");
}
setInterval(async () => {
  const key = await fingerprint();
  if (previous && previous !== key) for (const res of clients) res.write("data: reload\n\n");
  previous = key;
}, 1000).unref();

http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || "").split(":")[0];
    if (!["127.0.0.1", "localhost"].includes(host)) { res.writeHead(421); return res.end(); }
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path === "/__events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const base = resolve(root, path.startsWith("/src/") ? "src" : "public");
    const file = resolve(base, path === "/" ? "index.html" : path.replace(/^\/(src\/)?/, ""));
    if (!file.startsWith(base + sep)) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    const isWorkerTree = path.startsWith("/src/") && !path.startsWith("/src/host/");
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Security-Policy": isWorkerTree ? WORKER_CSP : PAGE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), accelerometer=(self), gyroscope=(self)",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Rill is running at http://127.0.0.1:${port}/`));
