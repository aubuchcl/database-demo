// Database access for the dashboard: connection pool, schema, seed data and queries.
// Connection settings come from the standard PG* environment variables
// (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE), which the pg library reads itself.

const { Pool } = require("pg");

const pool = new Pool({
  max: 5,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 10000,
});

pool.on("error", (err) => {
  console.error(`[db] idle client error: ${err.message}`);
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL UNIQUE,
  city       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id          serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  status      text NOT NULL CHECK (status IN ('paid', 'shipped', 'refunded')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id         integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       integer NOT NULL REFERENCES products(id),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);
`;

// A fictional outdoor-gear shop. Names are invented for the demo.
const PRODUCTS = [
  ["Trailhead Daypack 22L", "Packs", 8900],
  ["Summit Pack 45L", "Packs", 17900],
  ["Ridgeline Rain Shell", "Apparel", 14900],
  ["Merino Base Layer", "Apparel", 7400],
  ["Canyon Hiking Socks (3-pack)", "Apparel", 2400],
  ["Alpine Trekking Poles", "Gear", 9800],
  ["Basecamp Headlamp", "Gear", 3900],
  ["Stormproof Tent 2P", "Camp", 32900],
  ["Down Sleeping Bag 20°F", "Camp", 24900],
  ["Insulated Camp Mug", "Camp", 2800],
  ["Water Filter Bottle", "Gear", 4500],
  ["Trail Runner Shoes", "Footwear", 13900],
];

const FIRST = ["Ava", "Liam", "Maya", "Noah", "Zoe", "Ethan", "Lena", "Owen", "Iris", "Caleb",
  "Nora", "Felix", "Ruby", "Jonah", "Hazel", "Miles", "Clara", "Theo", "Elise", "Arlo"];
const LAST = ["Brooks", "Chen", "Delgado", "Ellis", "Foster", "Garcia", "Hayes", "Ito", "Jensen",
  "Khan", "Lopez", "Moreau", "Novak", "Okafor", "Patel", "Quinn", "Reyes", "Sato", "Turner", "Vance"];
const CITIES = ["Denver", "Portland", "Seattle", "Boise", "Salt Lake City", "Bend", "Missoula",
  "Flagstaff", "Asheville", "Burlington"];

// Small deterministic PRNG so every fresh database gets the same-looking data.
function mulberry32(seed) {
  let a = seed;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

async function seed(client) {
  const rand = mulberry32(20260922);
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const [name, category, price] of PRODUCTS) {
    await client.query(
      "INSERT INTO products (name, category, price_cents) VALUES ($1, $2, $3)",
      [name, category, price]
    );
  }

  const customerIds = [];
  const usedEmails = new Set();
  while (customerIds.length < 60) {
    const first = pick(rand, FIRST);
    const last = pick(rand, LAST);
    const email = `${first}.${last}@example.com`.toLowerCase();
    if (usedEmails.has(email)) {
      continue;
    }
    usedEmails.add(email);
    const joined = new Date(now - Math.floor(rand() * 120) * DAY);
    const { rows } = await client.query(
      "INSERT INTO customers (name, email, city, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [`${first} ${last}`, email, pick(rand, CITIES), joined]
    );
    customerIds.push(rows[0].id);
  }

  // 90 days of orders: busier weekends and a gentle upward trend.
  const orderRows = [];
  for (let daysAgo = 89; daysAgo >= 0; daysAgo--) {
    const day = new Date(now - daysAgo * DAY);
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    const base = 5 + (89 - daysAgo) / 18;
    let count = Math.round(base + rand() * 5);
    if (weekend) {
      count += 4;
    }
    for (let i = 0; i < count; i++) {
      const at = new Date(day.getTime() - Math.floor(rand() * DAY * 0.9));
      if (at.getTime() > now) {
        continue;
      }
      const roll = rand();
      let status = "shipped";
      if (daysAgo < 3 && roll < 0.6) {
        status = "paid";
      }
      if (roll > 0.95) {
        status = "refunded";
      }
      orderRows.push({ at, status, customer: pick(rand, customerIds) });
    }
  }

  const { rows: productRows } = await client.query("SELECT id, price_cents FROM products");
  for (const order of orderRows) {
    const { rows } = await client.query(
      "INSERT INTO orders (customer_id, status, created_at) VALUES ($1, $2, $3) RETURNING id",
      [order.customer, order.status, order.at]
    );
    const orderId = rows[0].id;
    const itemCount = 1 + Math.floor(rand() * 3);
    const chosen = new Set();
    while (chosen.size < itemCount) {
      chosen.add(pick(rand, productRows));
    }
    for (const product of chosen) {
      const qty = rand() < 0.8 ? 1 : 2;
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)",
        [orderId, product.id, qty, product.price_cents]
      );
    }
  }
  return orderRows.length;
}

// Create tables and seed them once. The advisory lock stops two ui instances
// from seeding at the same time when they start together.
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(424242)");
    await client.query(SCHEMA);
    const { rows } = await client.query("SELECT count(*)::int AS n FROM products");
    if (rows[0].n > 0) {
      console.log("[db] schema ready, data already present");
      return;
    }
    await client.query("BEGIN");
    const orders = await seed(client);
    await client.query("COMMIT");
    console.log(`[db] seeded ${orders} orders`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.query("SELECT pg_advisory_unlock(424242)").catch(() => {});
    client.release();
  }
}

// Retry until the database is reachable; it may still be starting up.
async function waitForDatabase() {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await ensureSchema();
      return;
    } catch (err) {
      const wait = Math.min(attempt * 1000, 5000);
      console.error(`[db] not ready (${err.code || err.message}), retrying in ${wait / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

const REVENUE = "SUM(oi.quantity * oi.unit_price_cents)";

async function dashboard() {
  const summary = await pool.query(`
    WITH order_totals AS (
      SELECT o.id, o.created_at, ${REVENUE} AS total
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status <> 'refunded'
      GROUP BY o.id
    )
    SELECT
      COALESCE(SUM(total) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::bigint AS revenue_30d,
      COALESCE(SUM(total) FILTER (WHERE created_at >= now() - interval '60 days'
                                    AND created_at <  now() - interval '30 days'), 0)::bigint AS revenue_prev_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS orders_30d,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '60 days'
                         AND created_at <  now() - interval '30 days')::int AS orders_prev_30d,
      (SELECT COUNT(*) FROM customers)::int AS customers,
      (SELECT COUNT(*) FROM customers WHERE created_at >= now() - interval '30 days')::int AS new_customers_30d
    FROM order_totals
  `);

  const daily = await pool.query(`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days',
        date_trunc('day', now() AT TIME ZONE 'UTC'),
        interval '1 day'
      )::date AS day
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0)::bigint AS revenue,
           COUNT(DISTINCT o.id)::int AS orders
    FROM days d
    LEFT JOIN orders o
      ON (o.created_at AT TIME ZONE 'UTC')::date = d.day AND o.status <> 'refunded'
    LEFT JOIN order_items oi ON oi.order_id = o.id
    GROUP BY d.day
    ORDER BY d.day
  `);

  const topProducts = await pool.query(`
    SELECT p.name, p.category,
           SUM(oi.quantity)::int AS units,
           ${REVENUE}::bigint AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    WHERE o.status <> 'refunded' AND o.created_at >= now() - interval '30 days'
    GROUP BY p.id
    ORDER BY revenue DESC
    LIMIT 5
  `);

  const recent = await pool.query(`
    SELECT o.id, c.name AS customer, c.city, o.status, o.created_at,
           SUM(oi.quantity)::int AS items,
           ${REVENUE}::bigint AS total
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    JOIN order_items oi ON oi.order_id = o.id
    GROUP BY o.id, c.id
    ORDER BY o.created_at DESC
    LIMIT 10
  `);

  return {
    summary: summary.rows[0],
    daily: daily.rows,
    top_products: topProducts.rows,
    recent_orders: recent.rows,
  };
}

// What the database itself can tell us about the connection.
async function connectionInfo() {
  const started = process.hrtime.bigint();
  await pool.query("SELECT 1");
  const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;

  const { rows } = await pool.query(`
    SELECT current_setting('server_version') AS version,
           current_database() AS database,
           pg_size_pretty(pg_database_size(current_database())) AS size,
           host(inet_server_addr()) AS server_addr,
           host(inet_client_addr()) AS client_addr,
           (SELECT count(*) FROM customers)::int AS customers,
           (SELECT count(*) FROM products)::int AS products,
           (SELECT count(*) FROM orders)::int AS orders,
           (SELECT count(*) FROM order_items)::int AS order_items
  `);
  return Object.assign({ latency_ms: Number(latencyMs.toFixed(2)) }, rows[0]);
}

// Insert one random order so the dashboard visibly changes during a demo.
async function simulateOrder() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const customer = await client.query("SELECT id FROM customers ORDER BY random() LIMIT 1");
    const order = await client.query(
      "INSERT INTO orders (customer_id, status) VALUES ($1, 'paid') RETURNING id",
      [customer.rows[0].id]
    );
    const products = await client.query(
      "SELECT id, price_cents FROM products ORDER BY random() LIMIT (1 + floor(random() * 3))::int"
    );
    for (const product of products.rows) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, 1, $3)",
        [order.rows[0].id, product.id, product.price_cents]
      );
    }
    await client.query("COMMIT");
    return { id: order.rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, waitForDatabase, dashboard, connectionInfo, simulateOrder };
