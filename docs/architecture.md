# Architecture

Internal reference for contributors and advanced operators who want to understand what they're running.

---

## Module Dependency Graph

```
index.ts (barrel export)
    ├── server.ts ─────────┬── access-keys.ts ── amounts.ts
    │                      ├── constants.ts
    │                      ├── errors.ts
    │                      ├── logger.ts ── runtime.ts
    │                      ├── rate-limit.ts ── errors.ts
    │                      ├── stores/index.ts ── stores/{memory,upstash,cloudflare-kv,bridge}.ts
    │                      ├── tracing.ts
    │                      ├── webhooks.ts ── runtime.ts
    │                      └── types.ts
    ├── client.ts ─────────┬── constants.ts
    │                      ├── errors.ts
    │                      ├── logger.ts
    │                      └── types.ts
    ├── dashboard.ts ────── server.ts (type-only)
    ├── discovery.ts ────── server.ts (type-only), types.ts, errors.ts
    ├── metrics.ts ─────── server.ts (type-only), amounts.ts
    ├── auth.ts ─────────── (standalone, Node crypto only)
    ├── tracing.ts ─────── (standalone, OTel types only)
    └── webhooks.ts ────── logger.ts, runtime.ts
```

Key design rule: `server.ts` is the gravity well. Everything else is either consumed by it or operates independently. The barrel (`index.ts`) re-exports everything for convenience but each sub-path export (`mpp-mcp-gateway/stores`, `mpp-mcp-gateway/auth`, etc.) is independently importable and tree-shakeable.

---

## Request Lifecycle

Every tool call flows through the same pipeline regardless of pricing mode:

```
┌─────────────────────────────────────────────────────────────────┐
│  Incoming MCP tool call (via stdio, HTTP, or SSE transport)     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │  Shutdown Gate       │  shuttingDown? → ShuttingDownError
                    └──────────┬──────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │  Rate Limiter        │  consume(bucketKey)
                    │                     │  denied? → RateLimitExceededError
                    └──────────┬──────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │  In-Flight ++        │  counter incremented
                    │  Root Span Start    │  mppmcp.tool.call
                    └──────────┬──────────┘
                              │
                              ▼
                ┌─────────────────────────────┐
                │  Pricing Router             │
                │                             │
                │  free?         → run handler│
                │  access-key?   → try redeem │
                │  session?      → advance ch │
                │  per-call/tiered? → charge  │
                └──────────────┬──────────────┘
                              │
              ┌───────────────┴───────────────┐
              │ (first call, no valid cred)    │
              ▼                               ▼
    ┌──────────────────┐            ┌──────────────────┐
    │  402 Challenge   │            │  Payment Verified │
    │  (McpError       │            │  (credential OK)  │
    │   code: -32042)  │            └────────┬─────────┘
    └──────────────────┘                     │
              │                              ▼
              │                    ┌─────────────────────┐
              │                    │  User Handler        │
              │                    │  (mppmcp.handler.run)│
              │                    └────────┬────────────┘
              │                             │
              │                             ▼
              │                    ┌─────────────────────┐
              │                    │  Stats + Revenue     │
              │                    │  Call Log Append     │
              │                    │  Webhook Emit        │
              │                    └────────┬────────────┘
              │                             │
              ▼                             ▼
    ┌──────────────────────────────────────────────────────┐
    │  Root Span End + In-Flight --                        │
    │  Response returned to client                         │
    └──────────────────────────────────────────────────────┘
```

---

## Pricing Flow Details

### Per-Call / Tiered

```
Client                     Server                      Tempo Chain
  │                          │                             │
  │── callTool(args) ───────▶│                             │
  │                          │── rate limit check          │
  │                          │── mppx.charge() ──────────▶│
  │◀── 402 + challenge ─────│                             │
  │                          │                             │
  │── sign tx ──────────────▶│                             │
  │                          │── verify + broadcast ─────▶│
  │                          │◀── receipt ────────────────│
  │                          │── run handler              │
  │◀── result + receipt ────│                             │
```

### Session

```
Client                     Server                      Tempo Chain
  │                          │                             │
  │── callTool (no cred) ──▶│                             │
  │◀── 402 + session open ──│                             │
  │                          │                             │
  │── open channel tx ─────▶│                             │
  │                          │── broadcast open ─────────▶│
  │                          │◀── channel confirmed ─────│
  │◀── result + receipt ────│                             │
  │                          │                             │
  │── callTool (voucher) ──▶│                             │
  │                          │── validate voucher         │
  │                          │── run handler              │
  │◀── result ─────────────│                             │
  │         ...              │                             │
  │                          │                             │
  │── closeSession ────────▶│                             │
  │                          │── settle highest voucher ─▶│
  │                          │◀── settlement tx ─────────│
  │◀── closed + receipt ────│                             │
```

### Access Key

```
Client                     Server                      Tempo Chain
  │                          │                             │
  │── callTool (no key) ───▶│                             │
  │                          │── mppx.charge() ─────────▶│
  │◀── 402 + challenge ────│                             │
  │                          │                             │
  │── sign tx ─────────────▶│                             │
  │                          │── verify + broadcast ────▶│
  │                          │◀── receipt ───────────────│
  │                          │── run handler             │
  │                          │── issue access key        │
  │                          │── store key in store      │
  │◀── result + key + rcpt ─│                             │
  │                          │                             │
  │── callTool (with key) ─▶│                             │
  │                          │── redeem(store, key, tool) │
  │                          │── key valid? decrement     │
  │                          │── run handler             │
  │◀── result + key state ──│                             │
```

---

## Store Interface

```ts
interface MppMcpStore {
    get<T>(key: string): Promise<T | null>
    put(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    update<T>(key: string, transform: (current: T | null) => T | null): Promise<T | null>
}
```

### Adapter Matrix

| Adapter | Atomicity | Multi-instance | Edge-safe | Best for |
|---------|-----------|---------------|-----------|----------|
| `createMemoryStore()` | ✅ Synchronous | ❌ Single process | ✅ | Dev, tests, single instance |
| `createUpstashStore(redis)` | ✅ Lua CAS | ✅ Shared state | ✅ | Production (any runtime) |
| `createCloudflareKvStore(ns)` | ⚠️ Best-effort | ⚠️ Eventually consistent | ✅ | Access keys on Workers |
| `bridgeMppxStore(legacy)` | ⚠️ No CAS | Depends on backing | ✅ | Migration from mppx stores |

---

## Event Emission Points

Where each webhook event fires from in `server.ts`:

| Event | Emission site | Condition |
|-------|---------------|-----------|
| `payment.received` | After `mppx.charge()` settles (per-call, tiered), after voucher validates (session), after access-key upfront charge | Always on successful payment |
| `access-key.issued` | After `storeRecord()` in `runAccessKey` | Key freshly minted |
| `access-key.expired` | In `runAccessKey` when `redeem()` returns `expired` or `exhausted` | Key rejected on use |
| `session.opened` | In `runSession` after detecting `action === 'open'` | First call on a new channel |
| `session.closed` | In `runSession` after detecting `action === 'close'` | Client-initiated settlement |
| `call.failed` | In `runWrappedHandler` catch block | Non-402 errors only |

---

## Span Tree (OpenTelemetry)

When `tracer` is configured, each paid call produces:

```
mppmcp.tool.call [root]
├── mppmcp.rate-limit          (currently implicit in consume())
├── mppmcp.payment.charge      (per-call/tiered/access-key upfront)
│   └── [mppx internal spans]
├── mppmcp.access-key.redeem   (access-key cached path)
├── mppmcp.session.advance     (session open/voucher/close)
└── mppmcp.handler.run         (user's handler function)
```

Attributes on the root span:
- `mppmcp.tool.name` — tool identifier
- `mppmcp.pricing.type` — `per-call | tiered | session | access-key | free`
- `mppmcp.payment.mode` — resolved mode (includes `access-key-cached`)
- `mppmcp.amount` — charged amount (paid paths only)
- `mppmcp.payment.tx-hash` — on-chain reference (when settled)
- `mppmcp.access-key.just-issued` — boolean (access-key path)
- `mppmcp.session.action` — `open | close | voucher` (session path)
- `mppmcp.error.code` — stable error code (on failure)

---

## Revenue Tracking

Revenue is tracked internally using `BigInt` arithmetic in base units (6 decimals, matching Tempo TIP-20 stablecoins). The public `stats.totalRevenue` and `stats.revenueByTool[tool]` fields are projected as decimal USD strings on every `getStats()` call.

This design prevents float accumulation drift. After millions of `$0.001` additions:
- **Float:** `0.001 * 1_000_000 = 999.9999999999459` (drift)
- **BigInt:** `1000n * 1_000_000n = 1_000_000_000n` → `'1000.000000'` (exact)

---

## Shutdown Sequence

```
SIGTERM received
    │
    ▼
server.close({ timeoutMs })
    │
    ├── 1. shuttingDown = true (new calls rejected)
    ├── 2. onShutdown() hook fires (user cleanup)
    ├── 3. Drain loop: poll inFlight every 50ms
    │      └── timeout? → ShutdownTimeoutError
    ├── 4. Webhook drain (best-effort within remaining budget)
    └── 5. mcp.close() — disconnect transport
```

---

## Build Output

11 entry points, each independently importable:

```
dist/
├── index.js / .d.ts        ← barrel (everything)
├── server.js / .d.ts       ← PaidMcpServer + createPaidMcpServer
├── client.js / .d.ts       ← PaidMcpClient + createPaidMcpClient
├── dashboard.js / .d.ts    ← mountDashboard
├── discovery.js / .d.ts    ← mountDiscovery + buildOpenApi
├── stores.js / .d.ts       ← all store adapters
├── rate-limit.js / .d.ts   ← all rate limiter implementations
├── auth.js / .d.ts         ← auth middleware factories
├── metrics.js / .d.ts      ← mountMetrics + formatMetrics
├── tracing.js / .d.ts      ← OTel helpers
└── webhooks.js / .d.ts     ← WebhookDispatcher + types
```

Users import only what they need: `import { formatMetrics } from 'mpp-mcp-gateway/metrics'` pulls in just the metrics formatter + amounts utility, not the entire server/client/auth stack.
