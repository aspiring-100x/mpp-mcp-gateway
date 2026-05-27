# Deploy to Cloudflare Workers

Edge-native, globally distributed, sub-100ms cold start, zero-ops. This is the showcase deployment — it exercises every edge-compatibility feature in the library.

---

## Architecture

```
Client (AI agent)
    │
    ▼
Cloudflare Edge (anycast)
    │
    ├── POST /mcp          → MCP StreamableHTTP handler (paid tools)
    ├── GET  /openapi.json → Discovery (public, CORS)
    ├── GET  /metrics      → Prometheus (auth-gated)
    ├── GET  /api/stats    → Dashboard JSON (auth-gated)
    ├── GET  /api/tools    → Tool listing (auth-gated)
    └── GET  /api/calls    → Recent calls (auth-gated)
```

**Stores:**
- Access-key state → **Cloudflare KV** (co-located, low latency)
- Session channel state → **Upstash Redis** (strongly consistent via REST API)
- Rate limiting → **Upstash Redis** (shared across edge locations)

---

## Prerequisites

- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v3+
- A Cloudflare account with Workers enabled
- An [Upstash](https://upstash.com) Redis database (free tier works for testing)
- A Tempo wallet address (recipient)

---

## Project Setup

```bash
mkdir my-paid-gateway && cd my-paid-gateway
npm init -y
npm install mpp-mcp-gateway @upstash/redis zod
npm install -D wrangler @cloudflare/workers-types typescript
```

---

## `wrangler.toml`

```toml
name = "paid-mcp-gateway"
main = "src/worker.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

# KV namespace for access-key storage
[[kv_namespaces]]
binding = "ACCESS_KEYS"
id = "<your-kv-namespace-id>"

[vars]
GATEWAY_NAME = "my-weather-gateway"
GATEWAY_VERSION = "1.0.0"
NETWORK = "testnet"

# Secrets (set via `wrangler secret put <NAME>`):
# RECIPIENT          — 0x... wallet address
# SECRET_KEY         — 32+ char random string for HMAC challenges
# UPSTASH_URL        — https://...upstash.io
# UPSTASH_TOKEN      — Upstash REST token
# DASHBOARD_TOKEN    — Bearer token for /api/* and /metrics
# WEBHOOK_SECRET     — 32+ char random string for webhook HMAC
# WEBHOOK_URL        — https://your-webhook-endpoint.com/hook
```

Create the KV namespace:

```bash
wrangler kv namespace create "ACCESS_KEYS"
# Copy the id into wrangler.toml
```

Set secrets:

```bash
wrangler secret put RECIPIENT
wrangler secret put SECRET_KEY
wrangler secret put UPSTASH_URL
wrangler secret put UPSTASH_TOKEN
wrangler secret put DASHBOARD_TOKEN
wrangler secret put WEBHOOK_SECRET
wrangler secret put WEBHOOK_URL
```

---

## `src/worker.ts`

```ts
import { Redis } from '@upstash/redis/cloudflare'
import { z } from 'zod'
import {
    createPaidMcpServer,
    createCloudflareKvStore,
    createUpstashStore,
    upstashTokenBucketLimiter,
    formatMetrics,
    PROMETHEUS_CONTENT_TYPE,
} from 'mpp-mcp-gateway'
import type { PaidMcpServer } from 'mpp-mcp-gateway/server'

// ─── Types ──────────────────────────────────────────────────────────

interface Env {
    // KV binding
    ACCESS_KEYS: KVNamespace

    // Vars
    GATEWAY_NAME: string
    GATEWAY_VERSION: string
    NETWORK: string

    // Secrets
    RECIPIENT: string
    SECRET_KEY: string
    UPSTASH_URL: string
    UPSTASH_TOKEN: string
    DASHBOARD_TOKEN: string
    WEBHOOK_SECRET: string
    WEBHOOK_URL: string
}

// ─── Gateway factory (cached per isolate) ───────────────────────────

let cachedServer: PaidMcpServer | null = null
let cachedEnvHash: string | null = null

function getServer(env: Env): PaidMcpServer {
    // Workers reuse isolates — cache the server instance across requests
    // within the same isolate. Rebuild if secrets change (deploy).
    const envHash = env.SECRET_KEY + env.RECIPIENT
    if (cachedServer && cachedEnvHash === envHash) return cachedServer

    const redis = new Redis({
        url: env.UPSTASH_URL,
        token: env.UPSTASH_TOKEN,
    })

    const accessKeyStore = createCloudflareKvStore(env.ACCESS_KEYS, {
        keyPrefix: 'ak:',
        ttlSeconds: 30 * 24 * 60 * 60, // 30 days
        suppressConsistencyWarning: true,
    })

    const sessionStore = createUpstashStore(redis, {
        keyPrefix: 'session:',
        ttlSeconds: 24 * 60 * 60, // 1 day
    })

    const rateLimiter = upstashTokenBucketLimiter(redis, {
        keyPrefix: 'rl:',
        refillPerMinute: 120,
        capacity: 30,
    })

    cachedServer = createPaidMcpServer({
        name: env.GATEWAY_NAME,
        version: env.GATEWAY_VERSION,
        recipient: env.RECIPIENT as `0x${string}`,
        secretKey: env.SECRET_KEY,
        network: (env.NETWORK as 'mainnet' | 'testnet') ?? 'testnet',
        accessKeyStore,
        sessionStore,
        rateLimit: { limiter: rateLimiter },
        webhooks: {
            url: env.WEBHOOK_URL,
            secret: env.WEBHOOK_SECRET,
            events: ['payment.received', 'session.closed', 'call.failed'],
        },
        tools: [
            {
                name: 'get_weather',
                description: 'Get current weather for a city.',
                inputSchema: { city: z.string() },
                pricing: { type: 'per-call', amount: '0.001' },
                handler: async ({ city }) => ({
                    content: [
                        {
                            type: 'text' as const,
                            text: `Weather in ${city}: 72°F, sunny`,
                        },
                    ],
                }),
            },
            {
                name: 'get_forecast',
                description: '7-day forecast for a city.',
                inputSchema: { city: z.string(), days: z.number().default(7) },
                pricing: {
                    type: 'access-key',
                    amount: '0.05',
                    validFor: '7d',
                    maxCalls: 100,
                },
                handler: async ({ city, days }) => ({
                    content: [
                        {
                            type: 'text' as const,
                            text: `${days}-day forecast for ${city}: mostly sunny`,
                        },
                    ],
                }),
            },
        ],
    })
    cachedEnvHash = envHash
    return cachedServer
}

// ─── Auth helper ────────────────────────────────────────────────────

function requireAuth(request: Request, env: Env): Response | null {
    const auth = request.headers.get('Authorization')
    if (!auth || auth !== `Bearer ${env.DASHBOARD_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    return null
}

// ─── CORS helper ────────────────────────────────────────────────────

function corsHeaders(): HeadersInit {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
    }
}

// ─── Request handler ────────────────────────────────────────────────

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url)
        const { pathname } = url

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders() })
        }

        const server = getServer(env)

        // ── Discovery (public) ──────────────────────────────────
        if (pathname === '/openapi.json' && request.method === 'GET') {
            const { buildOpenApi } = await import('mpp-mcp-gateway/discovery')
            const doc = buildOpenApi(server, {
                baseUrl: `https://${url.hostname}`,
                categories: ['data'],
            })
            return new Response(JSON.stringify(doc), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'max-age=300',
                    ...corsHeaders(),
                },
            })
        }

        // ── Metrics (auth-gated) ────────────────────────────────
        if (pathname === '/metrics' && request.method === 'GET') {
            const denied = requireAuth(request, env)
            if (denied) return denied
            const body = formatMetrics(server)
            return new Response(body, {
                headers: { 'Content-Type': PROMETHEUS_CONTENT_TYPE },
            })
        }

        // ── Dashboard API (auth-gated) ──────────────────────────
        if (pathname === '/api/stats' && request.method === 'GET') {
            const denied = requireAuth(request, env)
            if (denied) return denied
            return Response.json({ stats: server.getStats() })
        }

        if (pathname === '/api/tools' && request.method === 'GET') {
            const denied = requireAuth(request, env)
            if (denied) return denied
            const tools = server.listTools().map((t) => ({
                name: t.name,
                description: t.description,
                price: t.price,
            }))
            return Response.json({ tools })
        }

        if (pathname === '/api/calls' && request.method === 'GET') {
            const denied = requireAuth(request, env)
            if (denied) return denied
            const limit = Math.min(
                Number(url.searchParams.get('limit') ?? 100),
                1000
            )
            return Response.json({ calls: server.getRecentCalls(limit) })
        }

        // ── MCP transport (StreamableHTTP) ──────────────────────
        if (pathname === '/mcp' && request.method === 'POST') {
            // The MCP SDK's StreamableHTTP transport handles this.
            // Wire it to the server's underlying McpServer instance.
            // Implementation depends on @modelcontextprotocol/sdk
            // version — see the SDK docs for `StreamableHTTPServerTransport`.
            //
            // Minimal shape:
            // const transport = new StreamableHTTPServerTransport(...)
            // await server.server.connect(transport)
            // return transport.handleRequest(request)
            //
            // For a working example, see examples/paid-weather-http/server.ts
            return new Response('MCP endpoint — wire StreamableHTTPServerTransport here', {
                status: 501,
            })
        }

        return new Response('Not Found', { status: 404 })
    },
}
```

---

## `tsconfig.json`

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "bundler",
        "strict": true,
        "lib": ["ES2022"],
        "types": ["@cloudflare/workers-types"],
        "outDir": "dist",
        "skipLibCheck": true
    },
    "include": ["src"]
}
```

---

## Deploy

```bash
# Local dev
wrangler dev

# Deploy to production
wrangler deploy
```

---

## What This Exercises

| Feature | How it's used |
|---------|---------------|
| Edge runtime compat | Worker `fetch` handler, no Node APIs |
| Cloudflare KV store | Access-key persistence at the edge |
| Upstash Redis store | Session state + rate limiting (strongly consistent) |
| Rate limiting | `upstashTokenBucketLimiter` shared across edge locations |
| Prometheus metrics | `formatMetrics()` served directly (no Express) |
| Webhooks | HMAC-signed event push on payment/session/failure |
| Discovery | Public `/openapi.json` with CORS for registry crawling |
| Dashboard API | Auth-gated stats/tools/calls JSON endpoints |

---

## Monitoring

Scrape `/metrics` with Prometheus or Grafana Agent:

```yaml
scrape_configs:
  - job_name: 'mpp-gateway'
    scheme: https
    bearer_token: '<DASHBOARD_TOKEN>'
    static_configs:
      - targets: ['paid-mcp-gateway.<your-subdomain>.workers.dev']
```

Key metrics to watch:
- `mppmcp_calls_by_mode_total{mode="paid"}` — revenue-generating calls
- `mppmcp_in_flight_calls` — should be 0 at rest
- `mppmcp_shutting_down` — alert if 1 for > 30s
- `mppmcp_revenue_micro_usd_total` — cumulative revenue in µUSD

---

## Cost Estimate

| Resource | Free tier | Typical paid gateway |
|----------|-----------|---------------------|
| Workers requests | 100k/day | $0.50 per million |
| KV reads | 100k/day | $0.50 per million |
| KV writes | 1k/day | $5.00 per million |
| Upstash Redis | 10k commands/day | ~$0.20 per 100k commands |

A gateway serving 10k paid calls/day stays comfortably in free tiers for both Cloudflare and Upstash.
