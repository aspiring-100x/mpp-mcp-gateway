# Deploy to Vercel

Serverless deployment for TypeScript developers who already have a Vercel account. Low friction, zero infrastructure.

---

## Architecture

```
Client (AI agent)
    │
    ▼
Vercel Edge Network
    │
    ├── POST /api/mcp         → Serverless Function (MCP transport)
    ├── GET  /api/openapi     → Discovery (public, CORS)
    ├── GET  /api/metrics     → Prometheus metrics (auth-gated)
    ├── GET  /api/stats       → Gateway stats (auth-gated)
    ├── GET  /api/tools       → Tool listing (auth-gated)
    └── GET  /api/calls       → Recent call log (auth-gated)
```

**Stores:**
- Access-key state → **Upstash Redis** (via `@upstash/redis` REST client)
- Session channel state → **Upstash Redis** (same instance, different prefix)
- Rate limiting → **Upstash Redis** (shared across invocations)

---

## Prerequisites

- [Vercel CLI](https://vercel.com/docs/cli) or GitHub integration
- An [Upstash](https://upstash.com) Redis database (can provision directly from Vercel dashboard via the Upstash integration)
- A Tempo wallet address (recipient)

---

## Project Setup

```bash
mkdir my-paid-gateway && cd my-paid-gateway
npm init -y
npm install mpp-mcp-gateway @upstash/redis zod
npm install -D typescript @types/node vercel
```

---

## Environment Variables

Set these in the Vercel dashboard (Settings → Environment Variables) or via `.env.local` for development:

```env
# Wallet receiving payments
RECIPIENT=0xYourWalletAddress

# HMAC secret for payment challenges (32+ random chars)
SECRET_KEY=your-random-secret-key-here

# Upstash Redis (from Vercel integration or Upstash console)
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=AX...

# Auth for dashboard/metrics endpoints
DASHBOARD_TOKEN=your-dashboard-bearer-token

# Webhooks (optional)
WEBHOOK_URL=https://your-endpoint.com/webhook
WEBHOOK_SECRET=your-webhook-secret

# Network
NETWORK=testnet
```

---

## `vercel.json`

```json
{
    "functions": {
        "api/**/*.ts": {
            "maxDuration": 30
        }
    }
}
```

---

## Shared Gateway Instance

`lib/gateway.ts` — singleton factory shared across all API routes:

```ts
import { Redis } from '@upstash/redis'
import { z } from 'zod'
import {
    createPaidMcpServer,
    createUpstashStore,
    upstashTokenBucketLimiter,
    type PaidMcpServer,
} from 'mpp-mcp-gateway'

let server: PaidMcpServer | null = null

export function getGateway(): PaidMcpServer {
    if (server) return server

    const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })

    const accessKeyStore = createUpstashStore(redis, {
        keyPrefix: 'mppmcp:ak:',
        ttlSeconds: 30 * 24 * 60 * 60, // 30 days
    })

    const sessionStore = createUpstashStore(redis, {
        keyPrefix: 'mppmcp:session:',
        ttlSeconds: 24 * 60 * 60, // 1 day
    })

    const rateLimiter = upstashTokenBucketLimiter(redis, {
        keyPrefix: 'mppmcp:rl:',
        refillPerMinute: 120,
        capacity: 30,
    })

    server = createPaidMcpServer({
        name: 'my-gateway',
        version: '1.0.0',
        recipient: process.env.RECIPIENT! as `0x${string}`,
        secretKey: process.env.SECRET_KEY!,
        network: (process.env.NETWORK as 'mainnet' | 'testnet') ?? 'testnet',
        accessKeyStore,
        sessionStore,
        rateLimit: { limiter: rateLimiter },
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
                    content: [
                        {
                            type: 'text' as const,
                            text: `Weather in ${String(city)}: 72°F, sunny`,
                        },
                    ],
                }),
            },
        ],
    })

    return server
}
```

---

## API Routes

### `api/stats.ts`

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getGateway } from '../lib/gateway'

export default function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'GET') return res.status(405).end()
    if (!authorize(req)) return res.status(401).json({ error: 'unauthorized' })

    res.json({ stats: getGateway().getStats() })
}

function authorize(req: VercelRequest): boolean {
    const auth = req.headers.authorization
    return auth === `Bearer ${process.env.DASHBOARD_TOKEN}`
}
```

### `api/tools.ts`

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getGateway } from '../lib/gateway'

export default function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'GET') return res.status(405).end()
    if (!authorize(req)) return res.status(401).json({ error: 'unauthorized' })

    const tools = getGateway().listTools().map((t) => ({
        name: t.name,
        description: t.description,
        price: t.price,
    }))
    res.json({ tools })
}

function authorize(req: VercelRequest): boolean {
    return req.headers.authorization === `Bearer ${process.env.DASHBOARD_TOKEN}`
}
```

### `api/calls.ts`

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getGateway } from '../lib/gateway'

export default function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'GET') return res.status(405).end()
    if (!authorize(req)) return res.status(401).json({ error: 'unauthorized' })

    const limit = Math.min(Number(req.query.limit ?? 100), 1000)
    res.json({ calls: getGateway().getRecentCalls(limit) })
}

function authorize(req: VercelRequest): boolean {
    return req.headers.authorization === `Bearer ${process.env.DASHBOARD_TOKEN}`
}
```

### `api/metrics.ts`

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { formatMetrics, PROMETHEUS_CONTENT_TYPE } from 'mpp-mcp-gateway/metrics'
import { getGateway } from '../lib/gateway'

export default function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'GET') return res.status(405).end()
    if (req.headers.authorization !== `Bearer ${process.env.DASHBOARD_TOKEN}`) {
        return res.status(401).json({ error: 'unauthorized' })
    }

    res.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE)
    res.setHeader('Cache-Control', 'no-store')
    res.send(formatMetrics(getGateway()))
}
```

### `api/openapi.ts`

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { buildOpenApi } from 'mpp-mcp-gateway/discovery'
import { getGateway } from '../lib/gateway'

export default function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET')
        res.setHeader('Access-Control-Max-Age', '86400')
        return res.status(204).end()
    }
    if (req.method !== 'GET') return res.status(405).end()

    const host = req.headers.host ?? 'localhost'
    const proto = req.headers['x-forwarded-proto'] ?? 'https'
    const doc = buildOpenApi(getGateway(), {
        baseUrl: `${proto}://${host}`,
        categories: ['data'],
    })

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'max-age=300')
    res.json(doc)
}
```

---

## Deploy

```bash
# Local development
vercel dev

# Deploy to preview
vercel

# Deploy to production
vercel --prod
```

---

## Serverless Considerations

| Concern | How it's handled |
|---------|-----------------|
| Cold starts | Gateway construction is fast (no network calls). Tools register synchronously. |
| State across invocations | All state in Upstash Redis. In-memory store would lose data between invocations. |
| Rate limiting | `upstashTokenBucketLimiter` is durable across cold starts and concurrent invocations. |
| Graceful shutdown | Not applicable — functions are stateless. Each invocation handles one request. |
| `callLogSize` | Ring buffer is per-invocation in serverless. For persistent call logs, use a separate datastore. |
| Max duration | Set to 30s in `vercel.json`. MCP tool calls should complete well within this. |

---

## Important: Call Log Limitation

In a serverless environment, the in-memory ring buffer resets on each cold start. The `/api/calls` endpoint will only show calls handled by the current warm instance.

For persistent call logging in serverless, consider:
- Writing call entries to Upstash Redis (via a custom logger or webhook)
- Using the `payment.received` webhook to persist call records externally
- Deploying to a persistent runtime (Fly.io, Railway) if you need full call history
