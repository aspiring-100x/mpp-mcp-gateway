# mpp-mcp-gateway dashboard

A small React+Vite UI for monitoring a paid MCP server's revenue and live tool activity.

## What it shows

- Counters: total revenue, total/paid/free calls, access keys issued, sessions opened
- Tool table sorted by revenue: each tool's price, call count, accumulated revenue
- Live call log (last 200 calls), color-coded by payment mode

It polls `/api/stats`, `/api/tools`, and `/api/calls` every 2 seconds.

## Run it

The dashboard expects a gateway server exposing the dashboard endpoints — typically on the same Express app that hosts your MCP transport. The Streamable-HTTP example does this when you run it with `mountDashboard`:

```bash
# Terminal 1 — start a gateway with /api enabled
cd ..
npm run example:dashboard:server

# Terminal 2 — start the dashboard dev server
cd dashboard
npm install
npm run dev
```

The dev server runs on http://localhost:5173 and proxies `/api/*` to the gateway on port 3010 (override via `VITE_API_URL`).

## Build

```bash
npm run build
```

Produces a static bundle in `dashboard/dist/`. Serve it from any static host, or mount it on the gateway's Express app:

```ts
import express from 'express'
import path from 'node:path'

const app = express()
mountDashboard(server, app)             // /api/*
app.use(express.static('dashboard/dist')) // /, /assets/*
app.listen(3010)
```

## Customize

- Change refresh interval: edit `REFRESH_MS` in `src/useGateway.ts`.
- Change theme colors: tweak the `--*` CSS variables in `src/index.css`.
- The wire format types live in `src/types.ts` — keep them in sync with the gateway's `src/types.ts` if you extend the schema.
