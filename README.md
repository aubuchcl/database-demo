# Database Demo

Two containers in one Cycle environment: a public dashboard and a Postgres database. The dashboard queries the database by hostname over the environment's private network. The database has no public address.

```
 Internet
    │
    ▼
 load balancer ──▶ ui :8080                    public
                     │  postgres://demo@db:5432/shop
                     ▼
                   db :5432 (Postgres 17)      private only
```

| Container | Image | Public | Notes |
|---|---|---|---|
| `ui` | built from `/ui` | yes, via the load balancer (`80:8080`) | Node, one dependency (`pg`). Serves the page and runs the queries. |
| `db` | `postgres:17-alpine` from Docker Hub | no | Stateful, 5 GB volume for its data. |

## What the demo shows

A dashboard for a made-up outdoor-gear shop, "Outpost Supply":

- **Connection strip.** What `db` resolved to, the address the database sees the ui connecting from (`inet_client_addr()`), the Postgres version and database size, and the round trip for a `SELECT 1`. On Cycle those addresses are private IPv6 addresses on the environment network.
- **Stat tiles.** Revenue, orders and average order value for the last 30 days, each compared with the 30 days before, plus the customer count.
- **Daily revenue.** A column chart of the last 30 days. Hover or tab onto a bar for its value, or switch to the table view.
- **Top products and recent orders.** Both straight from SQL joins across `orders`, `order_items`, `products` and `customers`.
- **Simulate an order.** Inserts a random order. The tiles, today's bar and the recent-orders list update, and the new row flashes.

Good things to try live:

1. Click **Simulate an order** a few times and watch today's column and the tiles move.
2. Stop the `db` container. The connection dot turns red and the dashboard shows the error. Start it again and click **Refresh**.
3. Restart the `db` container. The data is still there because it lives on the volume.
4. Try to reach the database from outside. There's no public address to hit.

## Deploying on Cycle

1. Push this folder to a git repo Cycle can read.
2. In the portal, go to **Stacks → Create Stack**, choose the git repo source, and point it at the repo. The stack file is `cycle.json` in the repo root.
3. Create a build and set three variables:
   - `repo_url`: the same repo URL
   - `repo_branch`: e.g. `main`
   - `db_password`: any password. It's used for both `POSTGRES_PASSWORD` on the database and `PGPASSWORD` on the ui.
4. Deploy the build into a new environment and open the ui container's URL.

The ui creates the tables and loads the sample data itself the first time it connects: 12 products, 60 customers and about 1,000 orders over the last 90 days. It retries until the database is ready, so start order doesn't matter. If the tables already have data, it leaves them alone. An advisory lock stops two ui instances from seeding at the same time.

`cycle.json` validates against the official stack spec schema ([cycleplatform/api-spec](https://github.com/cycleplatform/api-spec)).

### Notes

- **Password.** The stack variable keeps the password out of the repo. For anything beyond a demo, a Cycle scoped variable is the better home for it.
- **Stateful database.** `db` is stateful with `use_base_hostname`, so the ui can always reach it as plain `db`.
- **Data directory.** `PGDATA` points at a subfolder of the volume (`/var/lib/postgresql/data/pgdata`), the approach the Postgres image recommends when the data directory is a mount point.
- **Dates.** The sample data is generated relative to when the database is first seeded, so a fresh environment always has "recent" orders. An older environment's chart will thin out toward today unless you simulate orders. To reseed, drop the four tables and restart the ui.
- **Fixed pool.** The ui keeps at most 5 connections to Postgres.

## Running it without Cycle

You need Node 20+ and a Postgres server with an empty `shop` database.

```bash
cd ui && npm install
PGHOST=localhost PGUSER=demo PGPASSWORD=secret PGDATABASE=shop PORT=8080 node server.js
```

Then open http://localhost:8080.

## Layout

```
cycle.json              Stack file: ui (public) and db (private, stateful)
ui/
  server.js             HTTP server: page, /api/dashboard, /api/connection, /api/orders/simulate
  db.js                 Connection pool, schema, seed data and SQL queries
  public/index.html     The dashboard
  package.json
  Dockerfile
```

## Endpoints

| Path | What it does |
|---|---|
| `GET /api/dashboard` | Tiles, 30-day series, top products and recent orders (4 queries) |
| `GET /api/connection` | DNS result for `db`, addresses as seen by Postgres, version, latency |
| `POST /api/orders/simulate` | Inserts one random paid order |
| `GET /health` | `{ ok, db_ready }` |
