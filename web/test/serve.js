/* Serves web/ for the tests the way Home Assistant serves /thuis/: with the
 * same Content-Security-Policy, read from the integration, so a change that
 * breaks under the policy fails here too. */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const INIT = path.resolve(__dirname, "../../ha/custom_components/thuispaneel/__init__.py");
const PORT = +(process.env.PORT || 8790);

function csp() {
  const src = fs.readFileSync(INIT, "utf8");
  const block = src.match(/^CSP = "; "\.join\(\s*\(([\s\S]*?)\)\s*\)/m);
  if (!block) throw new Error("CSP not found in " + INIT);
  const parts = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return `${parts.join("; ")}; connect-src 'self'`;
}
const POLICY = csp();
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".txt": "text/plain", ".glb": "model/gltf-binary", ".woff2": "font/woff2" };

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = path.resolve(ROOT, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Content-Security-Policy": POLICY,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`panel test server on :${PORT}`));
