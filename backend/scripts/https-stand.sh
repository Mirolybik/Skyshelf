#!/usr/bin/env bash
# SkyShelf — генерация TLS-сертификата и запуск HTTPS-стенда (порт 8443 -> стенд 8088 или backend 8080).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$BACKEND_DIR/certs"
mkdir -p "$CERT_DIR"

KEY_FILE="$CERT_DIR/privkey.pem"
CERT_FILE="$CERT_DIR/fullchain.pem"
HTTPS_PORT="${HTTPS_PORT:-8443}"
TARGET_URL="${TARGET_URL:-http://127.0.0.1:${STAND_PORT:-8088}}"

if [ ! -f "$KEY_FILE" ] || [ ! -f "$CERT_FILE" ]; then
  echo ">>> Генерация самоподписанного TLS-сертификата (SAN: localhost, 127.0.0.1)..."
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -subj "/C=RU/ST=Moscow/L=Moscow/O=IPTIP/OU=EFBO-14-24/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
fi

if [ "${1:-}" = "--cert-only" ]; then
  echo "✔ Сертификаты созданы в $CERT_DIR"
  exit 0
fi

echo ">>> Запуск HTTPS reverse-proxy на https://localhost:${HTTPS_PORT} -> ${TARGET_URL}"
exec node -e '
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const target = new URL(process.env.TARGET_URL);
const server = https.createServer({
  key: fs.readFileSync(process.env.KEY_FILE),
  cert: fs.readFileSync(process.env.CERT_FILE),
}, (req, res) => {
  const proxyReq = http.request({
    hostname: target.hostname,
    port: target.port || 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, "x-forwarded-proto": "https" },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, {
      ...proxyRes.headers,
      "strict-transport-security": "max-age=31536000; includeSubDomains",
    });
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (err) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Upstream unavailable: " + err.message }));
  });
  req.pipe(proxyReq);
});
server.listen(Number(process.env.HTTPS_PORT), "0.0.0.0", () => {
  console.log("✔ HTTPS-стенд доступен на https://localhost:" + process.env.HTTPS_PORT);
});
'
