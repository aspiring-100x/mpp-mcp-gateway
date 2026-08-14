# mpp-mcp-gateway

Monetize any MCP server with stablecoin micropayments via the Machine Payments Protocol (MPP) on the Tempo blockchain.

Build MCP tool servers that charge AI agents per-call, per-session, or via access keys — settled in pathUSD and other TIP-20 stablecoins. Build AI-agent clients that pay for those tools automatically with configurable spending caps.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Pricing Models](#pricing-models)
- [Server API](#server-api)
- [Client API](#client-api)
- [Transports](#transports)
- [Store Adapters](#store-adapters)
- [Rate Limiting](#rate-limiting)
- [Authentication Middleware](#authentication-middleware)
- [Dashboard & Monitoring](#dashboard--monitoring)
- [Service Discovery](#service-discovery)
- [Webhooks](#webhooks)
- [OpenTelemetry Tracing](#opentelemetry-tracing)
- [Operator CLI](#operator-cli)
- [Configuration Reference](#configuration-reference)
- [Examples](#examples)
- [Runtime Compatibility](#runtime-compatibility)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

## Overview

`mpp-mcp-gateway` is a TypeScript library that adds stablecoin micropayment gating to MCP (Model Context Protocol) servers. When an AI agent calls a paid tool, the server issues a 402 Payment Required challenge. The agent's client signs a payment transaction on the Tempo blockchain, retries the call with a credential, and the server verifies settlement before running the handler and returning the result with a receipt.

Key capabilities:

- **Four pricing models** — per-call, tiered, session (payment channels), and access-key (subscriptions)
- **Multi-currency support** — accept multiple TIP-20 stablecoins per tool
- **Exact revenue tracking** — BigInt arithmetic prevents float drift across millions of sub-cent payments
- **Pluggable storage** — in-memory, Upstash Redis (atomic CAS), Cloudflare KV, or bring your own
- **Rate limiting** — token bucket (in-memory or Redis-backed) with per-tool overrides
- **Auth middleware** — bearer token, API key, HTTP Basic, signed URLs, CORS — all timing-safe
- **Prometheus metrics** — `/metrics` endpoint, zero dependencies
- **OpenTelemetry tracing** — opt-in span tree per paid call, zero cost when disabled
- **Webhooks** — HMAC-signed event push with retry, backoff, and dead-letter hooks
- **Service discovery** — OpenAPI 3.1 with `x-payment-info` extensions (crawled by mpp.land)
- **Dashboard** — React UI + JSON API for live revenue and call monitoring
- **Graceful shutdown** — drain in-flight calls, fire hooks, settle webhooks
- **Runtime-portable** — works on Node.js 20+, Cloudflare Workers, Vercel Edge, Deno, Bun

## How It Works

```
┌─────────────┐         402 Challenge         ┌──────────────────┐
│  AI Agent   │ ────────────────────────────── │  Paid MCP Server │
│  (Client)   │                                │  (Gateway)       │
│             │ ◄── Payment Required (-32042)  │                  │
│             │                                │                  │
│  Signs tx   │ ── Credential (signed payment) │  Verifies on     │
│  via mppx   │                            ──► │  Tempo chain     │
│             │                                │                  │
│             │ ◄── Tool Result + Receipt      │  Runs handler    │
└─────────────┘                                └──────────────────┘
```

1. Agent calls a paid tool via MCP
2. Server responds with MCP error code `-32042` containing an MPP challenge
3. Client enforces spending caps, signs the payment, retries with a credential
4. Server verifies on-chain settlement via `mppx`
5. Handler runs, result is returned with a payment receipt (tx hash, timestamp)

## Installation

```bash
npm install mpp-mcp-gateway
```

Peer dependencies (install only what you use):

```bash
# For HTTP/Express transports and dashboard
npm install express

# For Upstash Redis stores / rate limiting
npm install @upstash/redis

# For OpenTelemetry tracing
npm install @opentelemetry/api

# For Cloudflare Workers KV store
npm install @cloudflare/workers-types
```

## Quick Start

### Server (tool provider)

```ts
import { createPaidMcpServer } from 'mpp-mcp-gateway/server'
import { z } from 'zod'

const server = createPaidMcpServer({
  name: 'my-api',
  version: '1.0.0',
  recipient: '0xYourWalletAddress',
  secretKey: process.env.PAYMENT_SECRET_KEY!,
  network: 'testnet',
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather for a city. $0.001 per call.',
      inputSchema: { city: z.string() },
      pricing: { type: 'per-call', amount: '0.001' },
      handler: async ({ city }) => ({
        content: [{ type: 'text', text: `Weather in ${city}: 72°F, sunny` }],
      }),
    },
    {
      name: 'ping',
      description: 'Free liveness check.',
      inputSchema: {},
      // No pricing = free tool
      handler: async () => ({
        content: [{ type: 'text', text: 'pong' }],
      }),
    },
  ],
})

await server.startStdio()
```

### Client (AI agent)

```ts
import { createPaidMcpClient } from 'mpp-mcp-gateway/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = createPaidMcpClient({
  name: 'my-agent',
  version: '1.0.0',
  privateKey: process.env.AGENT_PRIVATE_KEY! as `0x${string}`,
  maxPerCall: '0.10',    // safety cap: max $0.10 per single call
  maxTotal: '10.00',     // safety cap: max $10.00 total spend
  network: 'testnet',
})

const transport = new StdioClientTransport({
  command: 'node',
  args: ['server.js'],
})
await client.connect(transport)

// Free call — no payment required
const ping = await client.callTool('ping')
console.log(ping.content[0].text) // "pong"
console.log(ping.paid)            // false

// Paid call — automatic 402 → sign → retry
const weather = await client.callTool('get_weather', { city: 'Tokyo' })
console.log(weather.content[0].text) // "Weather in Tokyo: 72°F, sunny"
console.log(weather.paid)            // true
console.log(weather.receipt?.reference) // "0xabc...def" (tx hash)

await client.close()
```

## Pricing Models

### Per-Call

Fixed price per invocation. One on-chain transaction per call.

```ts
pricing: { type: 'per-call', amount: '0.001' }
```

### Tiered

Price decreases (or increases) based on cumulative call count.

```ts
pricing: {
  type: 'tiered',
  tiers: [
    { upTo: 100, amount: '0.01' },
    { upTo: 1000, amount: '0.005' },
    { upTo: 'unlimited', amount: '0.001' },
  ],
}
```

### Session (Payment Channels)

Agent opens an on-chain escrow channel once. Subsequent calls submit signed vouchers off-chain. Server settles the highest voucher when the channel closes. Best for streaming or high-frequency tools.

```ts
pricing: {
  type: 'session',
  amount: '0.0005',          // per-unit price
  unitType: 'request',       // informational label
  suggestedDeposit: '0.50',  // hint for initial channel funding
}
```

Client-side session management:

```ts
// Make multiple calls against the same channel
await client.callTool('think', { topic: 'AI alignment' })
await client.callTool('think', { topic: 'quantum computing' })

// Cooperatively close and settle on-chain
const result = await client.closeSession('think')
console.log(result.receipt.reference) // settlement tx hash
```

### Access Key (Subscriptions)

Agent pays once upfront and receives an opaque token. Subsequent calls present the token — no further payment until the key expires or is exhausted. Best for "buy a day pass" or "buy N calls" UX.

```ts
pricing: {
  type: 'access-key',
  amount: '0.01',       // upfront cost
  validFor: '1d',       // time limit (supports: 60s, 30m, 4h, 7d)
  maxCalls: 100,        // call limit (at least one of validFor/maxCalls required)
}
```

The client handles caching automatically:

```ts
// First call: pays $0.01, receives access key
const r1 = await client.callTool('premium_data', { query: 'foo' })
console.log(r1.paid)                    // true
console.log(r1.accessKey?.justIssued)   // true
console.log(r1.accessKey?.remainingCalls) // 99

// Subsequent calls: free (key presented in _meta)
const r2 = await client.callTool('premium_data', { query: 'bar' })
console.log(r2.paid)  // false
```

### Multi-Currency

Any pricing model can accept multiple TIP-20 stablecoins:

```ts
pricing: {
  type: 'per-call',
  amount: '0.001',
  accept: [
    { currency: '0x20c0...0000', amount: '0.001' }, // pathUSD
    { currency: '0x20c0...0001', amount: '0.001' }, // alphaUSD
  ],
}
```

## Server API

```ts
import { createPaidMcpServer, PaidMcpServer } from 'mpp-mcp-gateway/server'

const server = createPaidMcpServer(config)

// Start on stdio (for CLI / subprocess use)
await server.startStdio()

// Or access the underlying McpServer for custom transports
const mcpServer = server.server
await mcpServer.connect(someTransport)

// Runtime inspection
server.getStats()           // GatewayStats (calls, revenue, sessions, keys)
server.listTools()          // tool names, descriptions, current prices
server.getRecentCalls(100)  // last N calls from the ring buffer
server.getInFlightCount()   // currently active handlers
server.isShuttingDown()     // true after close() begins
server.describe()           // full descriptor for discovery/OpenAPI

// Access-key management
await server.listAccessKeys()          // live keys issued by this instance
await server.revokeAccessKey(token)    // { revoked: boolean }

// Graceful shutdown
await server.close({ timeoutMs: 25_000 })
```

## Client API

```ts
import { createPaidMcpClient, PaidMcpClient } from 'mpp-mcp-gateway/client'

const client = createPaidMcpClient(config)

await client.connect(transport)
await client.listTools()
const result = await client.callTool('tool_name', { arg: 'value' })

// Spending state
client.getSpending()    // { totalSpent, remaining, maxTotal, maxPerCall, ... }
client.resetSpending()  // reset cumulative counter (for tests)

// Access key management
client.getAccessKeys()          // cached keys by tool name
client.clearAccessKey('tool')   // force re-payment on next call
client.clearAccessKeys()        // drop all cached keys

// Session management
client.getOpenSessions()        // open channels by tool name
await client.closeSession('tool') // settle channel on-chain

await client.close()
```

## Transports

The gateway works with any MCP transport. Examples included:

| Transport | Use Case | Example |
|-----------|----------|---------|
| **stdio** | CLI tools, subprocess spawning | `examples/paid-weather-mcp/` |
| **Streamable HTTP** | Network servers (modern) | `examples/paid-weather-http/` |
| **SSE** (legacy) | Older MCP clients | `examples/paid-weather-sse/` |
| **In-Memory** | Testing, same-process | `examples/in-memory-demo/` |

## Store Adapters

The gateway uses a pluggable `MppMcpStore` interface for persisting access-key records and session channel state.

```ts
import { Store } from 'mpp-mcp-gateway/stores'
```

| Adapter | Atomicity | Use Case |
|---------|-----------|----------|
| `Store.memory()` | Atomic (promise-chain) | Tests, local dev, single-instance |
| `Store.upstash(redis)` | Atomic (Lua CAS) | Production, multi-instance |
| `Store.cloudflareKv(ns)` | Best-effort | Edge access keys (not for sessions) |
| `Store.bridge(legacy)` | Best-effort | Backward compat with mppx stores |

### Upstash Example

```ts
import { Redis } from '@upstash/redis'
import { createUpstashStore } from 'mpp-mcp-gateway/stores'

const store = createUpstashStore(
  new Redis({ url: process.env.UPSTASH_URL!, token: process.env.UPSTASH_TOKEN! }),
  { keyPrefix: 'mppmcp:', ttlSeconds: 30 * 24 * 3600 }
)

const server = createPaidMcpServer({
  // ...
  accessKeyStore: store,
  sessionStore: store,
})
```

### Custom Store

Implement the four-method interface:

```ts
interface MppMcpStore {
  get<T>(key: string): Promise<T | null>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  update<T>(key: string, transform: (current: T | null) => T | null): Promise<T | null>
}
```

The `update` method must guarantee atomic read-modify-write. The `transform` callback may be called multiple times under contention (CAS-style backends).

## Rate Limiting

Rate limiting fires before payment and handler logic — denied calls never issue a 402 or run your handler.

```ts
const server = createPaidMcpServer({
  // ...
  rateLimit: {
    refillPerMinute: 60,   // sustained rate
    capacity: 10,          // burst capacity
    perTool: {
      expensive_ai: { refillPerMinute: 5, capacity: 2 },
      cheap_lookup:  { refillPerMinute: 600, capacity: 100 },
    },
    // Custom bucketing (e.g. per-session on HTTP transports)
    keyExtractor: (toolName, extra) => `${toolName}:${extra.sessionId ?? 'default'}`,
  },
})
```

For multi-instance deployments, use the Upstash-backed limiter:

```ts
import { upstashTokenBucketLimiter } from 'mpp-mcp-gateway/rate-limit'

const limiter = upstashTokenBucketLimiter(redis, {
  keyPrefix: 'mppmcp:rl:',
  refillPerMinute: 120,
  capacity: 20,
})

const server = createPaidMcpServer({
  // ...
  rateLimit: { limiter },
})
```

## Authentication Middleware

Five Express middleware factories for protecting dashboard, metrics, and discovery endpoints:

```ts
import { auth } from 'mpp-mcp-gateway'

// Bearer token (constant-time comparison)
mountDashboard(server, app, {
  middleware: auth.bearerToken(process.env.DASHBOARD_TOKEN!, { realm: 'admin' }),
})

// API key in custom header
mountMetrics(server, app, {
  middleware: auth.apiKey({ header: 'x-api-key', value: process.env.METRICS_KEY! }),
})

// HTTP Basic Auth (multi-user)
mountDashboard(server, app, {
  middleware: auth.basicAuth({ users: { admin: 'secret' }, realm: 'gateway' }),
})

// HMAC-signed URLs with TTL
mountDashboard(server, app, {
  middleware: auth.signedQuery({ secret: process.env.URL_SECRET!, ttlSeconds: 300 }),
})

// Public CORS for registry crawlers
mountDiscovery(server, app, {
  middleware: auth.publicCors(),
})
```

## Dashboard & Monitoring

### JSON API

```ts
import { mountDashboard } from 'mpp-mcp-gateway'

mountDashboard(server, app, { prefix: '/api' })
```

Exposes:

| Endpoint | Response |
|----------|----------|
| `GET /api/stats` | `{ stats: GatewayStats }` — calls, revenue, sessions, keys, uptime |
| `GET /api/tools` | `{ tools: [{ name, description, price }] }` |
| `GET /api/calls?limit=N` | `{ calls: CallLogEntry[] }` — newest first |
| `GET /api/keys` | `{ keys: AccessKeyListEntry[] }` — live access keys |
| `DELETE /api/keys/:token` | `{ revoked: boolean }` — revoke a key (mutating; protect with middleware) |

### Prometheus Metrics

```ts
import { mountMetrics } from 'mpp-mcp-gateway'

mountMetrics(server, app, {
  middleware: auth.bearerToken(process.env.METRICS_TOKEN!),
})
```

Exposed metrics:

- `mppmcp_calls_total{tool}` — counter by tool
- `mppmcp_calls_by_mode_total{mode}` — paid, free, session, access_key, total
- `mppmcp_revenue_micro_usd_total{tool}` — cumulative revenue in micro-USD
- `mppmcp_in_flight_calls` — gauge of active handlers
- `mppmcp_access_keys_issued_total` / `expired_total`
- `mppmcp_sessions_opened_total` / `closed_total`
- `mppmcp_rate_limited_total` — calls rejected by the rate limiter
- `mppmcp_rejected_shutting_down_total` — calls rejected during shutdown
- `mppmcp_uptime_seconds`
- `mppmcp_shutting_down`

### React Dashboard

A pre-built React + Vite dashboard lives in `dashboard/`. It polls the JSON API every 2 seconds and displays:

- Revenue counters and tool table sorted by revenue
- Live call log color-coded by payment mode
- Access key and session statistics

```bash
cd dashboard
npm install
npm run build
```

Serve `dashboard/dist/` as static files from your Express app.

## Service Discovery

Generate and serve an OpenAPI 3.1 document with `x-payment-info` extensions per the MPP service-discovery IETF draft. Public registries like mpp.land crawl this automatically.

```ts
import { mountDiscovery } from 'mpp-mcp-gateway'

mountDiscovery(server, app, {
  baseUrl: 'https://api.example.com',
  categories: ['data', 'search'],
  docs: { homepage: 'https://example.com/docs' },
})
// GET /openapi.json → OpenAPI 3.1 with x-payment-info per tool
```

## Webhooks

Push events to a URL with HMAC-SHA-256 signatures. Delivery is fire-and-forget (non-blocking), with retry and exponential backoff.

```ts
const server = createPaidMcpServer({
  // ...
  webhooks: {
    url: 'https://example.com/webhook',
    secret: process.env.WEBHOOK_SECRET!,
    events: ['payment.received', 'session.closed'], // or omit for all
    maxAttempts: 3,
    onDrop: async (event, lastError) => {
      // Dead-letter: persist to DB for replay
      await db.insert('webhook_dlq', { event, error: lastError })
    },
  },
})
```

Event types: `payment.received`, `access-key.issued`, `access-key.expired`, `session.opened`, `session.closed`, `call.failed`

Receiver verification:

```ts
import { createHmac } from 'node:crypto'

function verify(req) {
  const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET)
    .update(`${req.headers['x-mppmcp-timestamp']}.${req.body}`)
    .digest('hex')
  return timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-mppmcp-signature']))
}
```

## OpenTelemetry Tracing

Opt-in. Pass a tracer to get a span tree per paid call. Zero overhead when disabled.

```ts
import { trace } from '@opentelemetry/api'

const server = createPaidMcpServer({
  // ...
  tracer: trace.getTracer('mpp-mcp-gateway', '1.0.0'),
})
```

Span tree:

```
mppmcp.tool.call (root)
├── mppmcp.payment.charge   (or mppmcp.session.advance, mppmcp.access-key.redeem)
└── mppmcp.handler.run
```

Attributes: `mppmcp.tool.name`, `mppmcp.pricing.type`, `mppmcp.amount`, `mppmcp.payment.mode`, `mppmcp.payment.tx-hash`, `mppmcp.session.action`, `mppmcp.error.code`

## Operator CLI

Inspect and manage deployed gateways from the command line:

```bash
npx mpp-mcp inspect https://my-gateway.fly.dev --token=secret123
npx mpp-mcp stats https://api.example.com
npx mpp-mcp tools https://api.example.com
npx mpp-mcp calls https://api.example.com --limit=50
npx mpp-mcp keys list https://api.example.com --token=admin
npx mpp-mcp keys revoke mppmcp_abc123... https://api.example.com --token=admin
```

## Configuration Reference

### Server (`PaidMcpServerConfig`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Server name advertised to clients |
| `version` | `string` | required | Server version |
| `recipient` | `0x${string}` | required | Wallet address receiving payments |
| `secretKey` | `string` | required | HMAC key for binding payment challenges |
| `tools` | `PaidToolDefinition[]` | required | Tool definitions with handlers |
| `currency` | `0x${string}` | pathUSD | TIP-20 stablecoin contract address |
| `network` | `'mainnet' \| 'testnet'` | `'testnet'` | Tempo network |
| `feePayerKey` | `0x${string}` | — | Server-sponsored gas (fee payer private key) |
| `sessionAccountKey` | `0x${string}` | — | Operator key required for session settlement |
| `escrowContract` | `0x${string}` | per-network default | Session escrow contract |
| `accessKeyStore` | `MppMcpStore` | in-memory | Persistence for access keys |
| `sessionStore` | `MppMcpStore` | in-memory | Persistence for session channels |
| `accessKeyBinding` | `'none' \| 'wallet'` | `'none'` | Bind keys to paying wallet |
| `callLogSize` | `number` | `1000` | Ring buffer capacity (0 = disabled) |
| `logger` | `Logger` | console+redaction | Structured logger |
| `drainTimeoutMs` | `number` | `30000` | Graceful shutdown timeout |
| `onShutdown` | `() => void` | — | Hook fired when drain begins |
| `rateLimit` | object | 60/min per tool | Rate limit configuration |
| `tracer` | `Tracer` | — | OpenTelemetry tracer (opt-in) |
| `webhooks` | `WebhookConfig` | — | Event push configuration |

### Client (`PaidMcpClientConfig`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | required | Client name |
| `version` | `string` | required | Client version |
| `privateKey` | `0x${string}` | required | Agent wallet private key |
| `maxPerCall` | `string` | `'1.00'` | Max spend per single call (USD) |
| `maxTotal` | `string` | `'100.00'` | Max cumulative spend (USD) |
| `maxSessionDeposit` | `string` | `'1.00'` | Max channel deposit (USD) |
| `network` | `'mainnet' \| 'testnet'` | `'testnet'` | Tempo network |
| `logger` | `Logger` | console+redaction | Structured logger |
| `verifySettlement` | `boolean` | `false` | Verify session settlement tx on-chain |

## Examples

| Example | Pricing | Transport | What it demonstrates |
|---------|---------|-----------|---------------------|
| `in-memory-demo` | per-call | InMemory | Full 402 round-trip in one process |
| `paid-weather-mcp` | per-call | stdio | Agent spawns server as subprocess |
| `paid-weather-http` | per-call | Streamable HTTP | Network server on Express |
| `paid-weather-sse` | per-call | SSE (legacy) | Backward-compatible SSE transport |
| `paid-weather-dashboard` | per-call + access-key | Streamable HTTP | Combined MCP + dashboard + discovery |
| `paid-streaming-mcp` | session | stdio | Payment channels, vouchers, close |
| `paid-subscription-mcp` | access-key | stdio | Day pass, time-only, call packs |
| `paid-peer-cash-mcp` | per-call | stdio | Gate Peer Cash tools, then cash out MPP revenue |

Run any example:

```bash
# In-memory demo (no wallet needed)
npm run example:demo

# Server + client pairs
npm run example:server      # then in another terminal:
npm run example:client

npm run example:http:server
npm run example:http:client

npm run example:streaming:server
npm run example:streaming:client

npm run example:subscription:server
npm run example:subscription:client

# Node.js 22+, Tempo mainnet
npm run example:peer-cash:server

# Dashboard (with all endpoints)
npm run example:dashboard:server
```

### Funding a Test Wallet

Paid examples require a funded wallet on Tempo testnet. The Peer Cash example
is the exception: it uses Tempo mainnet because the revenue route is live-only.

```bash
cast rpc tempo_fundAddress 0xYourAddress --rpc-url https://rpc.moderato.tempo.xyz
```

## Runtime Compatibility

The core library (server, client, stores, rate limit, amounts, access keys) is runtime-portable via Web Crypto:

| Runtime | Support |
|---------|---------|
| Node.js 20+ | Full |
| Cloudflare Workers | Full |
| Vercel Edge | Full |
| Deno | Full |
| Bun | Full |

The `auth.ts` middleware module uses `node:crypto` and requires Node.js. Edge deployments use their platform's native router and auth primitives instead.

## Architecture

```
src/
├── server.ts          PaidMcpServer — payment gating, stats, shutdown, webhooks
├── client.ts          PaidMcpClient — auto-payment, caps, key caching, sessions
├── types.ts           Core interfaces (PricingModel, configs, stats, results)
├── index.ts           Barrel exports (11 subpath entry points)
├── access-keys.ts     Issue, redeem (atomic), validate, duration parsing
├── amounts.ts         BigInt <-> USD string conversion (exact arithmetic)
├── auth.ts            5 Express middleware factories (timing-safe)
├── cli.ts             Operator CLI (inspect, stats, tools, calls, keys)
├── constants.ts       Tempo networks, token addresses, escrow contracts
├── dashboard.ts       JSON API: /api/stats, /api/tools, /api/calls
├── discovery.ts       OpenAPI 3.1 generation with x-payment-info
├── errors.ts          9 typed error classes with stable codes
├── logger.ts          Logger interface + 4 implementations + redaction
├── metrics.ts         Prometheus /metrics (hand-formatted, zero deps)
├── rate-limit.ts      RateLimiter interface + 3 implementations
├── runtime.ts         Cross-runtime: randomHex, writeLogLine, hmacSha256Hex
├── tracing.ts         OTel span helpers (no-op when disabled)
├── webhooks.ts        HMAC-signed event push with retry + dead-letter
└── stores/
    ├── types.ts       MppMcpStore interface
    ├── index.ts       Store namespace + re-exports
    ├── memory.ts      In-memory (atomic via promise chains)
    ├── upstash.ts     Upstash Redis (atomic via Lua CAS)
    ├── cloudflare-kv.ts  Cloudflare KV (best-effort)
    └── bridge.ts      Legacy 3-method store adapter
```

### Package Exports

```json
{
  ".": "Main barrel (everything)",
  "./server": "PaidMcpServer",
  "./client": "PaidMcpClient",
  "./dashboard": "mountDashboard",
  "./discovery": "mountDiscovery, buildOpenApi",
  "./stores": "Store adapters",
  "./rate-limit": "Rate limiter implementations",
  "./auth": "Auth middleware factories",
  "./metrics": "mountMetrics, formatMetrics",
  "./tracing": "startSpan, withSpan, TRACE_ATTRS",
  "./webhooks": "WebhookDispatcher, event types"
}
```

### Design Principles

- **Revenue exactness** — all money math uses `bigint` base units (6 decimals). No float drift after millions of operations.
- **Zero-cost opt-in** — tracing, webhooks, and rate limiting are no-ops unless configured. Non-traced deployments allocate no spans.
- **Pluggable everything** — stores, loggers, rate limiters, and auth are interface-based. Swap implementations without touching gateway code.
- **Fail fast** — configuration errors throw at construction time, not at request time.
- **Errors are values** — typed error classes with stable codes. Use `instanceof` or `err.code` for programmatic handling.
- **Ring buffer call log** — O(1) pre-allocated, never grows. No GC pressure under high throughput.
- **Graceful lifecycle** — shutdown gate rejects new calls, drain waits for in-flight, webhook flush, then disconnect.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Type check
npm run typecheck

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch

# Type tests (tsd)
npm run test:types

# Benchmarks
npm run bench

# Generate docs
npm run docs
```

### Test Suite

27+ test files covering:

- Access-key atomicity (concurrent redeems of N-call keys)
- Access-key flows (issue → redeem → exhaust → re-pay)
- Amount math (BigInt conversions, edge cases)
- Auth middleware (all 5 factories)
- Call-log ring buffer (wrap-around, capacity limits)
- Graceful shutdown & drain
- Dashboard API responses
- Discovery / OpenAPI generation
- Error taxonomy
- Free tools (no-payment path)
- Logger (structured output, redaction, child loggers)
- Prometheus metrics formatting
- Multi-currency discovery
- Paid flow (402 → credential → receipt)
- Pricing calculations (tiered, per-call)
- Rate limiting (token bucket, denial, retry-after)
- Revenue exactness (BigInt accumulation across many calls)
- Runtime helpers (randomHex, hmacSha256Hex)
- Session lifecycle (open → voucher → close → settle)
- Spending caps (per-call, total, session deposit)
- OpenTelemetry tracing (span attributes, error recording)
- Webhooks (delivery, retry, HMAC signature, dead-letter)
- Type tests (via `tsd`)
- Throughput benchmarks (via `vitest bench`)

### Graceful Shutdown

Wire `close()` to your container's shutdown signal:

```ts
process.on('SIGTERM', async () => {
  try {
    await server.close({ timeoutMs: 25_000 })
    process.exit(0)
  } catch {
    process.exit(1) // drain timed out
  }
})
```

### Structured Logging

The library ships a pluggable `Logger` interface. Default: JSON to stderr with automatic redaction of secrets (private keys, credentials, signed transactions).

```ts
import { consoleLogger, silentLogger, withRedaction } from 'mpp-mcp-gateway'

// Custom logger
const server = createPaidMcpServer({
  // ...
  logger: withRedaction(consoleLogger({ level: 'debug', pretty: true })),
})

// Silence for tests
const server = createPaidMcpServer({
  // ...
  logger: silentLogger(),
})
```

Adapt to pino, winston, or any logging library:

```ts
const adapter: Logger = {
  debug: (m, c) => pino.debug(c, m),
  info: (m, c) => pino.info(c, m),
  warn: (m, c) => pino.warn(c, m),
  error: (m, c) => pino.error(c, m),
  child: (bindings) => /* wrap pino.child(bindings) */,
}
```

## License

[MIT](LICENSE) — Gaurav Pant
