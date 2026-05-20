# Paid Weather + Dashboard

This example combines the Streamable HTTP transport with the dashboard, all on one Express app.

## What's served

| Path | What |
|---|---|
| `POST/GET /mcp` | MCP transport (paid weather tools) |
| `GET /api/stats` | Live `GatewayStats` |
| `GET /api/tools` | Tool descriptors with prices |
| `GET /api/calls?limit=N` | Last N calls, newest first |
| `GET /openapi.json` | OpenAPI 3.1 with `x-payment-info` (mpp.land registry) |
| `GET /` | The dashboard UI (if built) |

## Run it

### One-time setup — build the dashboard UI

```bash
cd dashboard
npm install
npm run build
cd ..
```

That produces `dashboard/dist/index.html`.

### Start the server

```bash
npm run example:dashboard:server
```

Visit **http://localhost:3010/** to see the dashboard. Connect any of the existing MCP clients (`example:client`, `example:http:client`, etc.) and call tools — the dashboard updates every 2 seconds.

### Or develop the UI separately

If you want to iterate on the dashboard with hot-reload:

```bash
# Terminal 1 — run the gateway
npm run example:dashboard:server

# Terminal 2 — run the Vite dev server
cd dashboard
npm run dev
```

The Vite dev server runs on `http://localhost:5173/` and proxies `/api/*` calls to `http://localhost:3010/`.

## Mounting the API on your own app

The dashboard exports both `mountDashboard` (to add the JSON endpoints) and the standalone Vite app under `dashboard/`. To wire them in your own Express app:

```ts
import express from 'express'
import { createPaidMcpServer, mountDashboard } from 'mpp-mcp-gateway'

const server = createPaidMcpServer({ ... })
const app = express()

// ... mount your MCP transport ...

mountDashboard(server, app, { prefix: '/api' })
app.use(express.static('dashboard/dist'))   // ship the prebuilt UI
app.listen(3010)
```

To put auth in front of the dashboard:

```ts
mountDashboard(server, app, {
    prefix: '/api',
    middleware: (req, res, next) => {
        if (req.header('x-api-key') === process.env.DASHBOARD_KEY) {
            next()
        } else {
            res.status(401).end()
        }
    },
})
```
