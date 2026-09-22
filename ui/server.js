// Dashboard UI: the only public container. Serves the page and queries
// Postgres directly over the environment's private network (hostname "db").

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const dnsPromises = require("dns").promises;
const db = require("./db");

const PORT = Number(process.env.PORT || 8080);
const DB_HOST = process.env.PGHOST || "db";
const INDEX_HTML = path.join(__dirname, "public", "index.html");
const INSTANCE = process.env.CYCLE_INSTANCE_ID || os.hostname();

let ready = false;

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function privateIps() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const addr of interfaces[name] || []) {
      if (addr.internal) {
        continue;
      }
      if (addr.family === "IPv6" && addr.address.startsWith("fe80")) {
        continue;
      }
      ips.push(`${addr.address} (${name})`);
    }
  }
  return ips;
}

async function resolveDbHost() {
  try {
    const records = await dnsPromises.lookup(DB_HOST, { all: true });
    return { host: DB_HOST, addresses: records.map((r) => r.address) };
  } catch (err) {
    return { host: DB_HOST, addresses: [], error: err.code || err.message };
  }
}

async function handleDashboard(res) {
  if (!ready) {
    sendJson(res, 503, { error: `Waiting for the database at ${DB_HOST}…` });
    return;
  }
  const started = process.hrtime.bigint();
  const data = await db.dashboard();
  data.query_ms = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1));
  sendJson(res, 200, data);
}

async function handleConnection(res) {
  const result = {
    ui: { instance: INSTANCE, hostname: os.hostname(), ips: privateIps() },
    db: { resolved: await resolveDbHost() },
  };
  try {
    result.db.info = await db.connectionInfo();
    result.db.ok = true;
  } catch (err) {
    result.db.ok = false;
    result.db.error = err.code || err.message;
  }
  sendJson(res, 200, result);
}

async function handleSimulate(res) {
  if (!ready) {
    sendJson(res, 503, { error: "Database not ready" });
    return;
  }
  sendJson(res, 201, await db.simulateOrder());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      fs.readFile(INDEX_HTML, (err, html) => {
        if (err) {
          res.writeHead(500);
          res.end("index.html missing");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, db_ready: ready });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      await handleDashboard(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/connection") {
      await handleConnection(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/orders/simulate") {
      await handleSimulate(res);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.code || err.message });
  }
});

// Cycle's private network is IPv6, so listen on "::" (dual-stack).
// Fall back to IPv4 on hosts that have IPv6 disabled.
function listen(host) {
  const onError = (err) => {
    if (err.code === "EAFNOSUPPORT" && host === "::") {
      server.removeAllListeners("listening");
      listen("0.0.0.0");
      return;
    }
    throw err;
  };
  server.once("error", onError);
  server.listen(PORT, host, () => {
    server.off("error", onError);
    console.log(`ui listening on ${host} port ${PORT}, database at ${DB_HOST}`);
  });
}
listen(process.env.HOST || "::");

// Start serving right away (the page shows a "waiting" state), then connect.
db.waitForDatabase().then(() => {
  ready = true;
});

function shutdown() {
  server.close(() => {
    db.pool.end().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
