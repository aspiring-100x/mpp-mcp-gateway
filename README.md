# mpp-mcp-gateway

Monetize MCP (Model Context Protocol) tools with stablecoin micropayments via the Machine Payments Protocol (MPP) on Tempo.

## What this is

A TypeScript library that lets you:
- **Build MCP servers whose tools charge stablecoins per call** (e.g. $0.001 per API hit)
- **Build AI agents that pay for those tools automatically** — no API keys, no signup, no billing accounts

Both sides use native MCP transports (stdio, SSE, HTTP). Payments settle in <1 second on Tempo's payments-first L1.

```
┌─────────────┐   MCP tool call    ┌──────────────────┐
│  AI Agent   │ ─────────────────▶ │  Paid MCP Server │
│  (wallet)   │ ◀──────────────────│  (your tools)    │
└─────────────┘   402 challenge    └──────────────────┘
       │                                  ▲
       │ sign tx + retry                  │ verify on-chain
       ▼                                  │
┌──────────────────────────────────────────┐
│           Tempo Blockchain                │
│    (pathUSD / AlphaUSD micropayments)     │
└──────────────────────────────────────────┘
```

## Why

- **MCP servers are free today.** Anyone can call any tool, so there's no sustainable way to run premium services.
- **MPP solves machine payments.** It's the HTTP 402-based protocol by Stripe × Tempo for agent-to-API payments.
- **This bridges them.** Charge for MCP tool calls in sub-cent stablecoin payments using the HMAC-bound challenge/receipt flow, with automatic on-chain verification.

## Install

```bash
npm install mpp-mcp-gateway
```

## Quick start

### Server — paid weather tool

```ts
// server.ts
import { createPaidMcpServer } from 'mpp-mcp-gateway/server'
import { z } from 'zod'

const server = createPaidMcpServer({
    name: 'weather',
    version: '1.0.0',
    recipient: '0xYourWallet',
    secretKey: process.env.PAYMENT_SECRET_KEY!,
    network: 'testnet',
    tools: [
        {
            name: 'get_weather',
            description: 'Get current weather for a city.',
            inputSchema: { city: z.string() },
            pricing: { type: 'per-call', amount: '0.001' },
            handler: async ({ city }) => ({
                content: [{ type: 'text', text: `Weather in ${city}: 72°F, clear` }],
            }),
        },
        {
            name: 'ping',
            description: 'Free liveness check.',
            inputSchema: {},
            // no pricing → free
            handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
        },
    ],
})

await server.startStdio()
```

### Client — AI agent that pays

```ts
// agent.ts
import { createPaidMcpClient } from 'mpp-mcp-gateway/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = createPaidMcpClient({
    name: 'my-agent',
    version: '1.0.0',
    privateKey: process.env.AGENT_PRIVATE_KEY! as `0x${string}`,
    maxPerCall: '0.10',
    maxTotal: '10.00',
})

await client.connect(new StdioClientTransport({
    command: 'node',
    args: ['server.js'],
}))

const result = await client.callTool('get_weather', { city: 'San Francisco' })
console.log(result.content[0].text)
console.log('paid:', result.paid)
console.log('tx:  ', result.receipt?.reference)
```

## Running the bundled examples

### 1. Typecheck & build

```bash
cd mpp-mcp-gateway
npm install
npm run build
```

### 2. In-memory demo (no subprocess, no testnet funds if server recipient = sender)

```bash
npm run example:demo
```

This spins the server and client up in the same process via `InMemoryTransport`. It proves the 402 challenge → sign → verify → receipt flow end-to-end.

### 3. Stdio demo (real subprocess)

```bash
npm run example:client
```

The client spawns the server as a subprocess, lists tools, calls a free tool, and pays for two paid tools. Each paid call produces a real transaction hash on Tempo testnet.

### 4. Streamable HTTP demo (modern network transport)

```bash
# Terminal 1
npm run example:http:server
# Terminal 2
npm run example:http:client
```

Single `/mcp` endpoint, stateful sessions via the `Mcp-Session-Id` header. See [`examples/paid-weather-http/`](examples/paid-weather-http/README.md) for curl examples.

### 5. SSE demo (legacy network transport)

```bash
# Terminal 1
npm run example:sse:server
# Terminal 2
npm run example:sse:client
```

Two-endpoint shape (`GET /sse` for the stream, `POST /messages?sessionId=…` for client messages). Useful when integrating with clients that haven't migrated to Streamable HTTP. See [`examples/paid-weather-sse/`](examples/paid-weather-sse/README.md).

### 6. Session pricing demo (channel-based, sub-100ms per call)

```bash
# Terminal 1
npm run example:streaming:server
# Terminal 2
npm run example:streaming:client
```

The agent opens an on-chain escrow channel once (~1s), then signs incremental off-chain vouchers per call (~50ms each). Best for streaming or high-frequency tools. See [`examples/paid-streaming-mcp/`](examples/paid-streaming-mcp/README.md).

### 7. Access-key (subscription) pricing demo

```bash
# Terminal 1
npm run example:subscription:server
# Terminal 2
npm run example:subscription:client
```

Pay once, get a key. Subsequent calls present the key instead of paying. The key expires by time (`validFor`) or by call count (`maxCalls`) or both. Best for "buy a day pass" or "buy 1000 calls" UX. See [`examples/paid-subscription-mcp/`](examples/paid-subscription-mcp/README.md).

### 8. Live dashboard

```bash
# One-time: build the dashboard UI
cd dashboard && npm install && npm run build && cd ..

# Then start the combined server
npm run example:dashboard:server
```

Browse to **http://localhost:3010/** for live revenue counters, per-tool breakdowns, and a streaming call log. The same Express app hosts `POST/GET /mcp` for tool calls and `GET /api/{stats,tools,calls}` for the dashboard backend. See [`examples/paid-weather-dashboard/`](examples/paid-weather-dashboard/README.md).

### Funding the agent wallet

The default demo key (`0xac0974...`) is the standard Anvil test key #0. Fund any address on Tempo testnet with:

```bash
cast rpc tempo_fundAddress 0xYourAddress --rpc-url https://rpc.moderato.tempo.xyz
```

This airdrops 1M of each testnet stablecoin (pathUSD, AlphaUSD, BetaUSD, ThetaUSD).

## API

### `createPaidMcpServer(config)`

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Server name advertised to clients |
| `version` | string | required | Server version |
| `recipient` | `0x${string}` | required | Wallet receiving payments |
| `secretKey` | string | required | HMAC key binding challenges. Keep private. |
| `currency` | `0x${string}` | pathUSD | TIP-20 token accepted |
| `network` | `'mainnet' \| 'testnet'` | `'testnet'` | Which chain to settle on |
| `tools` | `PaidToolDefinition[]` | required | The paid / free tools to expose |
| `feePayerKey` | `0x${string}` | — | Private key for server-side fee sponsorship |
| `accessKeyStore` | `MppMcpStore` | in-memory | Persistent store for access-key records |
| `sessionStore` | `MppMcpStore` | in-memory | Persistent store for session channel state |
| `callLogSize` | number | `1000` | Ring buffer capacity (set 0 to disable) |
| `logger` | `Logger` | console+redaction | Structured logger instance |
| `drainTimeoutMs` | number | `30000` | Graceful shutdown drain window |
| `onShutdown` | `() => void` | — | Hook fired when `close()` begins |
| `rateLimit` | object | `{ enabled: true }` | Rate limiting config (see docs) |
| `tracer` | `Tracer` | — | OpenTelemetry tracer (opt-in) |
| `webhooks` | `WebhookConfig` | — | Webhook endpoint + secret + events |

### `PaidToolDefinition`

```ts
{
    name: string
    description: string
    inputSchema: Record<string, z.ZodTypeAny>  // Zod shape
    pricing?: { type: 'per-call'; amount: '0.01' }  // or 'tiered'; omit for free
    handler: (args) => Promise<{ content: [...], data?: any }>
}
```

### Pricing models

```ts
// Flat per-call — one Tempo tx per call (~1s settlement)
{ type: 'per-call', amount: '0.01' }

// Tiered by call count — first N calls cheaper, then ramp
{ type: 'tiered', tiers: [
    { upTo: 100, amount: '0.01' },
    { upTo: 1000, amount: '0.005' },
    { upTo: 'unlimited', amount: '0.001' },
]}

// Session — open one channel, sign vouchers per call (~50ms each)
// Best for streaming or high-frequency tools.
{
    type: 'session',
    amount: '0.0001',           // per-unit price
    unitType: 'request',        // free-form unit label ('second', 'token', ...)
    suggestedDeposit: '0.05',   // hint to client about channel funding
    minVoucherDelta: '0.0001',  // optional anti-dust floor
}

// Access key — pay once, call until the key expires or runs out.
// Best for "day pass" / "1000-call pack" / "subscription" patterns.
{
    type: 'access-key',
    amount: '1.00',         // upfront payment
    validFor: '7d',         // optional: '60s'/'15m'/'4h'/'7d'/'30d'
    maxCalls: 1000,         // optional: per-key call cap
    // At least one of validFor or maxCalls is required.
}
```

| | `per-call` / `tiered` | `session` | `access-key` |
|---|---|---|---|
| First-call latency | ~1s | ~1s (channel open) | ~1s (charge + key issuance) |
| Subsequent-call latency | ~1s each | ~50ms each (off-chain voucher) | sub-50ms (no MPP at all) |
| On-chain txs per N calls | N | 2 (open + close) | 1 (the upfront charge) |
| Best for | Discrete API hits | Streaming, chat-style tools | Subscription / day-pass UX |
| Practical floor | ~$0.001 | ~$0.0001 | flat upfront |

You can mix all four pricing modes on the same server. Free tools have no `pricing` field.

### `createPaidMcpClient(config)`

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | string | required | Client name advertised to servers |
| `version` | string | required | Client version |
| `privateKey` | `0x${string}` | required | Agent wallet key |
| `maxPerCall` | string | `'1.00'` | Reject any tool call more expensive than this |
| `maxTotal` | string | `'100.00'` | Cumulative spend cap across all calls |
| `maxSessionDeposit` | string | `'1.00'` | Max channel deposit the client will sign on session open |
| `network` | `'mainnet' \| 'testnet'` | `'testnet'` | Which chain to sign against |

Caps are enforced **before** any transaction is signed. A challenge that exceeds `maxPerCall` or `maxTotal` throws `SpendingCapExceededError`. A session challenge whose `suggestedDeposit` exceeds `maxSessionDeposit` throws `SessionDepositCapExceededError`. Neither error consumes any on-chain gas.

## How it works

1. Agent calls `get_weather`. Server sees no payment credential, issues a `McpError(-32042)` with an HMAC-bound MPP challenge in `error.data.challenges`.
2. Client catches the error, finds a matching method intent (`tempo.charge`), signs a Tempo `transferWithMemo` transaction for the exact amount.
3. Client retries the same tool call with the serialized transaction in `_meta["org.paymentauth/credential"]`.
4. Server decodes the credential, submits the signed tx to Tempo RPC, waits for on-chain confirmation.
5. Server returns the tool result with a `Receipt` in `_meta["org.paymentauth/receipt"]` (method, tx hash, timestamp).
6. Client surfaces the content + receipt.

Deterministic finality on Tempo (~0.6s blocks, no reorgs) means the agent round-trip stays sub-second even with on-chain settlement.

## Network constants

```ts
// Testnet (Moderato)
TEMPO_TESTNET = {
    chainId: 42431,
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    explorerUrl: 'https://explore.testnet.tempo.xyz',
}

// Mainnet
TEMPO_MAINNET = {
    chainId: 4217,
    rpcUrl: 'https://rpc.tempo.xyz',
    explorerUrl: 'https://explore.tempo.xyz',
}

TESTNET_TOKENS = {
    pathUSD:  '0x20c0000000000000000000000000000000000000',
    alphaUSD: '0x20c0000000000000000000000000000000000001',
    betaUSD:  '0x20c0000000000000000000000000000000000002',
    thetaUSD: '0x20c0000000000000000000000000000000000003',
}
```

## Built on

- [MPP](https://mpp.dev) — Machine Payments Protocol (Stripe × Tempo)
- [mppx](https://github.com/wevm/mppx) — TypeScript SDK for MPP with MCP integration
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — MCP client/server
- [Tempo](https://tempo.xyz) — Payments-first L1 blockchain
- [viem](https://viem.sh) — Ethereum / Tempo transaction library

## Transports

The library is transport-agnostic — `PaidMcpServer.server` exposes the underlying `McpServer` so you can connect any transport from `@modelcontextprotocol/sdk`. `PaidMcpClient.connect(transport)` accepts any client transport.

| Transport | Use case | Example |
|---|---|---|
| **stdio** | Local subprocesses, Claude Desktop integrations | [`examples/paid-weather-mcp/`](examples/paid-weather-mcp/) |
| **Streamable HTTP** | Modern network transport — single endpoint, sessions over `Mcp-Session-Id` | [`examples/paid-weather-http/`](examples/paid-weather-http/) |
| **SSE** | Legacy network transport — `GET /sse` + `POST /messages?sessionId=…` | [`examples/paid-weather-sse/`](examples/paid-weather-sse/) |
| **In-memory** | Tests and same-process demos | [`examples/in-memory-demo/`](examples/in-memory-demo/) |

The 402 → sign → retry → receipt flow is identical across all transports — only the wire format changes.

## Dashboard

The library ships an optional dashboard for live revenue and call-log visibility:

```ts
import express from 'express'
import { createPaidMcpServer, mountDashboard } from 'mpp-mcp-gateway'

const server = createPaidMcpServer({ ... })
const app = express()
mountDashboard(server, app)              // adds GET /api/{stats,tools,calls}
app.use(express.static('dashboard/dist')) // optional UI
```

Endpoints (all read-only, no auth by default — pin them behind your own middleware in production):

| Endpoint | Returns |
|---|---|
| `GET /api/stats` | `{ stats: GatewayStats }` — totals, revenue, session counts |
| `GET /api/tools` | `{ tools: [{ name, description, price }] }` |
| `GET /api/calls?limit=N` | `{ calls: CallLogEntry[] }` — newest first, capped at 1000 |

The bundled UI under `dashboard/` is a small Vite + React app that polls these endpoints every 2 seconds. See [`dashboard/README.md`](dashboard/README.md) for build/dev workflow, or [`examples/paid-weather-dashboard/`](examples/paid-weather-dashboard/) for a one-process server-plus-UI setup.

## Discovery

Public registries like [mpp.land](https://mpp.land) crawl OpenAPI documents annotated with the `x-payment-info` extension defined in [`draft-payment-discovery-00`](https://github.com/tempoxyz/mpp-specs/blob/main/specs/extensions/draft-payment-discovery-00.md). The library's `mountDiscovery` does this for you:

```ts
import { mountDiscovery } from 'mpp-mcp-gateway'

mountDiscovery(server, app, {
    baseUrl: 'https://api.example.com',
    categories: ['data', 'search'],
    docs: { homepage: 'https://example.com/docs' },
})
// GET /openapi.json now serves a discoverable spec.
```

The generated document includes:

- Top-level `x-service-info` (categories, doc links)
- One operation per registered tool, with full Zod-derived input schemas
- `x-payment-info.offers[]` per-operation matching the IETF discovery draft
- `402 Payment Required` declared on paid operations
- `Cache-Control: max-age=300` per spec recommendation

Once your server is publicly reachable over HTTPS, mpp.land and similar registries will pick it up automatically — no submission flow required. The 402 challenge remains authoritative; discovery is purely advisory.

## Stores

The library needs persistent state for access keys and session channels. Three adapters ship out of the box:

```ts
import { Store } from 'mpp-mcp-gateway/stores'

// In-memory (default) — single process, lost on restart
const store = Store.memory()

// Upstash Redis — atomic CAS, multi-instance safe, edge-compatible
import { Redis } from '@upstash/redis'
const redis = new Redis({ url: '...', token: '...' })
const store = Store.upstash(redis, { keyPrefix: 'mppmcp:' })

// Cloudflare KV — eventually consistent, best for access keys on Workers
const store = Store.cloudflareKv(env.MY_KV, { keyPrefix: 'ak:' })
```

Pass stores via `accessKeyStore` and `sessionStore` in server config.

## Auth, Metrics, and Rate Limiting

```ts
import express from 'express'
import {
    createPaidMcpServer,
    mountDashboard,
    mountDiscovery,
    mountMetrics,
    auth,
} from 'mpp-mcp-gateway'

const server = createPaidMcpServer({ ... })
const app = express()

// Dashboard — auth-gated
mountDashboard(server, app, {
    middleware: auth.bearerToken(process.env.DASHBOARD_TOKEN!),
})

// Metrics — Prometheus text format, auth-gated
mountMetrics(server, app, {
    middleware: auth.bearerToken(process.env.METRICS_TOKEN!),
})

// Discovery — public with CORS for registry crawlers
mountDiscovery(server, app, {
    middleware: auth.publicCors(),
    baseUrl: 'https://api.example.com',
})
```

Rate limiting is on by default (60 req/min/tool). For multi-instance deployments:

```ts
import { upstashTokenBucketLimiter } from 'mpp-mcp-gateway/rate-limit'

const server = createPaidMcpServer({
    // ...
    rateLimit: {
        limiter: upstashTokenBucketLimiter(redis, {
            keyPrefix: 'rl:',
            refillPerMinute: 120,
            capacity: 30,
        }),
    },
})
```

## Webhooks

Push events to your own endpoint when payments settle, sessions open/close, or calls fail:

```ts
const server = createPaidMcpServer({
    // ...
    webhooks: {
        url: 'https://example.com/mppmcp/webhook',
        secret: process.env.WEBHOOK_SECRET!,
        events: ['payment.received', 'session.closed', 'call.failed'],
    },
})
```

Events are HMAC-signed (`X-MppMcp-Signature`), fire-and-forget with retry (1s → 4s → 16s).

## CLI

Inspect and manage deployed gateways from the command line:

```bash
npx mpp-mcp inspect https://my-gateway.fly.dev --token=secret
npx mpp-mcp stats https://api.example.com --token=admin
npx mpp-mcp tools https://api.example.com --token=admin
npx mpp-mcp calls https://api.example.com --token=admin --limit=50
npx mpp-mcp keys list https://api.example.com --token=admin
```

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/production-checklist.md`](docs/production-checklist.md) | Go-live tick-list |
| [`docs/deployment-cloudflare-workers.md`](docs/deployment-cloudflare-workers.md) | Edge deployment guide |
| [`docs/deployment-vercel.md`](docs/deployment-vercel.md) | Serverless deployment guide |
| [`docs/deployment-fly-io.md`](docs/deployment-fly-io.md) | Persistent process deployment |
| [`docs/architecture.md`](docs/architecture.md) | Internals reference (diagrams, data flow) |
| [`docs/migration-from-0.1.md`](docs/migration-from-0.1.md) | Upgrade guide |
| [`docs/api-stability.md`](docs/api-stability.md) | Export stability classifications |

## Roadmap

### Shipped ✅

- [x] Per-call, tiered, session, and access-key pricing
- [x] Cooperative session close — `client.closeSession()` settles on-chain
- [x] Access keys — subscription-style recurring access
- [x] Dashboard UI — live revenue tracking, per-tool analytics
- [x] Discovery — OpenAPI + `x-payment-info` for registry crawling
- [x] HTTP / SSE / stdio transport examples
- [x] Multi-currency offers — tools can advertise acceptance of multiple stablecoins
- [x] Persistent stores — Upstash Redis (atomic CAS), Cloudflare KV, in-memory
- [x] Rate limiting — in-memory token bucket + Upstash Redis (multi-instance)
- [x] Auth middleware — bearer token, API key, basic auth, signed query, public CORS
- [x] Prometheus `/metrics` endpoint
- [x] OpenTelemetry tracing — opt-in span tree per paid call
- [x] Structured logging with secret redaction
- [x] Graceful shutdown with drain timeout
- [x] Webhooks — 6 event types, HMAC-signed, retry with backoff
- [x] Error taxonomy — 9 typed error classes with stable codes
- [x] BigInt-exact revenue tracking (no float drift)
- [x] O(1) ring-buffer call log
- [x] Edge runtime compatibility (Workers, Vercel Edge, Deno, Bun)
- [x] Operator CLI — `npx mpp-mcp inspect/stats/tools/calls/keys`
- [x] API stability freeze with `docs/api-stability.md`
- [x] Performance benchmarks
- [x] TypeDoc API reference
- [x] Type-level test suite (tsd)
- [x] Deployment guides (Cloudflare Workers, Vercel, Fly.io)
- [x] Production checklist + architecture reference

### Next

- [ ] Published to npm
- [ ] CI pipeline (GitHub Actions: test, release, integration)
- [ ] TypeDoc site deployed to GitHub Pages
- [ ] CHANGELOG automation (changesets or similar)

## License

MIT
