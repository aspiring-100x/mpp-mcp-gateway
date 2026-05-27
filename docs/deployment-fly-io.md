# Deploy to Fly.io

Traditional persistent-process deployment — a long-lived server with in-memory state backed by shared Redis. Good for session channels that benefit from long-lived state and operators who want a box they can SSH into.

---

## Architecture

```
Client (AI agent)
    │
    ▼
Fly.io Anycast (global edge)
    │
    ▼
Fly Machine (single region or multi-region)
    │
    ├── POST /mcp          → Express + MCP StreamableHTTP
    ├── GET  /openapi.json → Discovery (public CORS)
    ├── GET  /metrics      → Prometheus (auth-gated)
    └── GET  /api/*        → Dashboard (auth-gated)
    │
    ▼
Upstash Redis (managed via Fly integration)
    ├── Access-key store
    ├── Session store
    └── Rate limiter
```

---

## Prerequisites

- [Fly CLI (`flyctl`)](https://fly.io/docs/hands-on/install-flyctl/)
- A Fly.io account
- A Tempo wallet address (recipient)

---

## Project Setup

```bash
mkdir my-paid-gateway && cd my-paid-gateway
npm init -y
npm install mpp-mcp-gateway @upstash/redis express zod
npm install -D typescript @types/node @types/express
```

---

## `src/main.ts`

```ts
import express from 'express'
import { Redis } from '@upstash/redis'
import { z } from 'zod'
import {
    createPaidMcpServer,
    createUpstashStore,
    upstashTokenBucketLimiter,
    mountDashboard,
    mountDiscovery,
    mountMetrics,
    auth,
    consoleLogger,
} from 'mpp-mcp-gateway'

// ─── Environment ────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000)
const RECIPIENT = process.env.RECIPIENT! as `0x${string}`
const SECRET_KEY = process.env.SECRET_KEY!
const NETWORK = (process.env.NETWORK ?? 'testnet') as 'mainnet' | 'testnet'
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN!
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!

// ─── Redis + Stores ─────────────────────────────────────────────────

const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN })

const accessKeyStore = createUpstashStore(redis, {
    keyPrefix: 'mppmcp:ak:',
    ttlSeconds: 30 * 24 * 60 * 60,
})

const sessionStore = createUpstashStore(redis, {
    keyPrefix: 'mppmcp:session:',
    ttlSeconds: 24 * 60 * 60,
})

const rateLimiter = upstashTokenBucketLimiter(redis, {
    keyPrefix: 'mppmcp:rl:',
    refillPerMinute: 120,
    capacity: 30,
})

// ─── Gateway ────────────────────────────────────────────────────────

const logger = consoleLogger({ level: 'warn' })

const server = createPaidMcpServer({
    name: 'my-gateway',
    version: '1.0.0',
    recipient: RECIPIENT,
    secretKey: SECRET_KEY,
    network: NETWORK,
    accessKeyStore,
    sessionStore,
    rateLimit: { limiter: rateLimiter },
    logger,
    drainTimeoutMs: 25_000, // 5s buffer before Fly kills the process
    webhooks: process.env.WEBHOOK_URL
        ? {
              url: process.env.WEBHOOK_URL,
              secret: process.env.WEBHOOK_SECRET!,
          }
        : undefined,
    tools: [
        {
            name: 'get_weather',
            description: 'Get current weather for a city.',
            inputSchema: { city: z.string() },
            pricing: { type: 'per-call', amount: '0.001' },
            handler: async ({ city }) => ({
                content: [{ type: 'text' as const, text: `Weather in ${String(city)}: 72°F` }],
            }),
        },
        {
            name: 'premium_forecast',
            description: '7-day premium forecast with access key.',
            inputSchema: { city: z.string() },
            pricing: { type: 'access-key', amount: '0.10', validFor: '7d', maxCalls: 50 },
            handler: async ({ city }) => ({
                content: [{ type: 'text' as const, text: `Premium forecast for ${String(city)}` }],
            }),
        },
    ],
})

// ─── Express ────────────────────────────────────────────────────────

const app = express()

// Dashboard + metrics — auth-gated
mountDashboard(server, app, {
    middleware: auth.bearerToken(DASHBOARD_TOKEN),
})
mountMetrics(server, app, {
    middleware: auth.bearerToken(DASHBOARD_TOKEN),
})

// Discovery — public with CORS
mountDiscovery(server, app, {
    middleware: auth.publicCors(),
    baseUrl: process.env.BASE_URL ?? `https://my-gateway.fly.dev`,
    categories: ['data'],
})

// MCP transport — wire your StreamableHTTP handler here
// app.post('/mcp', ...)

// Health check (Fly uses this for readiness)
app.get('/health', (_req, res) => {
    if (server.isShuttingDown()) {
        res.status(503).json({ status: 'draining' })
    } else {
        res.json({ status: 'ok', inFlight: server.getInFlightCount() })
    }
})

// ─── Start + Graceful Shutdown ──────────────────────────────────────

const httpServer = app.listen(PORT, () => {
    console.log(`Gateway listening on :${PORT}`)
})

async function shutdown(signal: string) {
    console.log(`${signal} received, starting graceful shutdown...`)
    // Stop accepting new HTTP connections
    httpServer.close()
    try {
        await server.close({ timeoutMs: 25_000 })
        console.log('Shutdown complete')
        process.exit(0)
    } catch (err) {
        console.error('Shutdown timed out:', err)
        process.exit(1)
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
```

---

## `Dockerfile`

```dockerfile
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

---

## `fly.toml`

```toml
app = "my-paid-gateway"
primary_region = "iad"  # US East — pick the region closest to your users

[build]

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

  [http_service.concurrency]
    type = "requests"
    hard_limit = 250
    soft_limit = 200

[[services.http_checks]]
  interval = "10s"
  timeout = "2s"
  grace_period = "5s"
  method = "GET"
  path = "/health"

[processes]
  app = "node dist/main.js"

# Graceful shutdown: Fly sends SIGTERM and waits this long before SIGKILL
[kill_signal]
  signal = "SIGTERM"

[kill_timeout]
  timeout = "30s"
```

---

## Redis via Fly's Upstash Integration

```bash
# Launch the app
fly launch

# Provision Upstash Redis
fly redis create --region iad

# This sets UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN as secrets automatically
```

Set the remaining secrets:

```bash
fly secrets set RECIPIENT="0xYourWallet"
fly secrets set SECRET_KEY="$(openssl rand -hex 32)"
fly secrets set DASHBOARD_TOKEN="$(openssl rand -hex 16)"
fly secrets set NETWORK="testnet"
fly secrets set WEBHOOK_URL="https://your-endpoint.com/hook"
fly secrets set WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

---

## Deploy

```bash
fly deploy
```

---

## Multi-Region

For global latency, run multiple Fly machines in different regions:

```bash
fly scale count 3 --region iad,lhr,sin
```

All instances share the same Upstash Redis, so:
- Access-key state is consistent across regions
- Rate limits are enforced globally
- Session channels work correctly (Upstash CAS ensures voucher ordering)

---

## Scaling Considerations

| Concern | Single instance | Multi-instance |
|---------|----------------|----------------|
| Store | Memory or Upstash | **Must use Upstash** |
| Rate limit | In-memory ok | **Must use Upstash** |
| Call log | Full history in ring buffer | Per-instance (dashboard shows partial) |
| Sessions | Works naturally | Upstash ensures consistency |
| Shutdown | SIGTERM → drain → exit | Each instance drains independently |

---

## Monitoring

Wire Prometheus scraping via Fly Metrics or your own Grafana:

```bash
# Fly exposes a Prometheus endpoint per-app
fly metrics dashboard
```

Or scrape `/metrics` directly:

```yaml
scrape_configs:
  - job_name: 'mpp-gateway'
    scheme: https
    bearer_token_file: /etc/secrets/dashboard-token
    static_configs:
      - targets: ['my-paid-gateway.fly.dev']
```
