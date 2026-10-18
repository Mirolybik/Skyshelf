/* SkyShelf frontend static server (Node.js). Раздаёт статику и проксирует /api на backend. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5500);
const BACKEND = process.env.API_UPSTREAM || 'http://127.0.0.1:8080';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.otf': 'font/otf', '.ttf': 'font/ttf',
  '.ico': 'image/x-icon', '.json': 'application/json',
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { ...SECURITY, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function proxy(req, res) {
  const upstream = new URL(BACKEND);
  const options = {
    hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: upstream.host },
  };
  const out = http.request(options, (incoming) => {
    const headers = { ...incoming.headers };
    for (const k of Object.keys(headers)) if (['transfer-encoding', 'connection'].includes(k)) delete headers[k];
    res.writeHead(incoming.statusCode, headers);
    incoming.pipe(res);
  });
  out.on('error', () => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"message":"Сервер недоступен."}'); });
  req.pipe(out);
}

http.createServer((req, res) => (req.url.startsWith('/api/') ? proxy(req, res) : serveStatic(req, res)))
  .listen(PORT, '127.0.0.1', () => console.log(`SkyShelf frontend: http://127.0.0.1:${PORT}`));
