# Migration from v0.1

Guide for anyone upgrading from the original release to the current version. All changes are backward-compatible at the API surface unless noted, but internal behaviors have shifted.

---

## Breaking Changes

### 1. Store interface: `update()` is now required

**Before (v0.1):** The store interface had three methods — `get`, `put`, `delete` (matching mppx's `Store.Store`).

**Now:** The library expects `MppMcpStore` with four methods — `get`, `put`, `delete`, `update`. The `update` method enables atomic compare-and-swap for access-key redemption.

**What to do:**

If you pass an `MppMcpStore` (from `createUpstashStore`, `createCloudflareKvStore`, or `createMemoryStore`), nothing changes — these already implement `update`.

If you pass a legacy three-method store (e.g. from mppx's `Store.memory()`), the library auto-wraps it via `bridgeMppxStore()` with a best-effort `update` shim and logs a one-shot deprecation warning:

```
[WARN] Legacy three-method store detected — wrapping with bridgeMppxStore().
       update() uses non-atomic read-transform-write. Migrate to createMemoryStore()
       or createUpstashStore() for atomic access-key redemption.
```

**Recommended:** Replace `Store.memory()` from mppx with `createMemoryStore()` from this library:

```diff
- import { Store } from 'mppx'
- const store = Store.memory()
+ import { createMemoryStore } from 'mpp-mcp-gateway/stores'
+ const store = createMemoryStore()
```

---

### 2. Error classes moved to `errors.ts`

**Before:** `SpendingCapExceededError` and `SessionDepositCapExceededError` were defined in `client.ts`.

**Now:** All error classes live in `src/errors.ts`. They're re-exported from `client.ts` for backward compatibility, so existing imports still work:

```ts
// Still works:
import { SpendingCapExceededError } from 'mpp-mcp-gateway/client'

// Also works (preferred):
import { SpendingCapExceededError } from 'mpp-mcp-gateway'
```

No action needed unless you imported from an internal path.

---

### 3. Revenue strings are now exact (no float drift)

**Before:** `stats.totalRevenue` and `stats.revenueByTool[tool]` were accumulated using floating-point addition. After many sub-cent calls, drift appeared:
```
totalRevenue: '0.999999999999459'  // should be '1.000000'
```

**Now:** Revenue tracking uses `BigInt` arithmetic internally. Public stats always show exact decimal strings with 6 decimal places:
```
totalRevenue: '1.000000'
```

**Impact:** If your code parsed `totalRevenue` as a float and compared it loosely, you'll now see more trailing zeros (`'0.001000'` instead of `'0.001'`). If you used string equality checks, update your expected values.

---

### 4. Call log is now a ring buffer

**Before:** The call log was an unbounded array. `server.getRecentCalls()` returned the last N entries via `Array.slice()`.

**Now:** The call log is a pre-allocated ring buffer of fixed size (`callLogSize`, default 1000). Old entries are overwritten in O(1) with no array growth or GC pressure.

**Impact on tests:** If you poked at `callLog.length` in gray-box tests, those assertions may break. Use `server.getRecentCalls(limit)` instead — the public API is unchanged.

---

## New Optional Config Fields

These fields were added and default to sensible values. No action required unless you want to opt in:

| Field | Default | Purpose |
|-------|---------|---------|
| `logger` | `defaultLogger()` (console + redaction) | Structured logging |
| `rateLimit` | `{ enabled: true, refillPerMinute: 60 }` | Throttle 402 issuance |
| `drainTimeoutMs` | `30_000` | Graceful shutdown drain window |
| `onShutdown` | `undefined` | Hook for cleanup on `close()` |
| `tracer` | `undefined` | OpenTelemetry span tree |
| `webhooks` | `undefined` | Push events on payment/session/failure |
| `callLogSize` | `1000` | Ring buffer capacity |

---

## New Exports

The library now ships 11 entry points. If you were importing everything from the barrel (`mpp-mcp-gateway`), all new exports are available without changing your import path:

```ts
// New sub-path imports available:
import { ... } from 'mpp-mcp-gateway/auth'
import { ... } from 'mpp-mcp-gateway/metrics'
import { ... } from 'mpp-mcp-gateway/tracing'
import { ... } from 'mpp-mcp-gateway/webhooks'
import { ... } from 'mpp-mcp-gateway/rate-limit'
```

---

## New Peer Dependencies (all optional)

| Package | When needed |
|---------|-------------|
| `@opentelemetry/api` | Only if you set `tracer` in config |
| `@upstash/redis` | Only if using Upstash stores or rate limiter |
| `@cloudflare/workers-types` | Only if deploying to Cloudflare Workers |
| `express` | Only if using `mountDashboard`, `mountDiscovery`, `mountMetrics`, or `auth.*` |

---

## Behavioral Changes (non-breaking)

### Rate limiting is now on by default

New servers get a 60 req/min/tool in-memory token bucket. If your tests make rapid successive calls, they may hit the limiter. Disable in tests:

```ts
const server = createPaidMcpServer({
    // ...
    rateLimit: { enabled: false },
})
```

### Shutdown rejects new calls

After `server.close()` is called, new tool calls throw `ShuttingDownError` instead of proceeding. In-flight calls complete normally. This is the correct production behavior but may surprise tests that call tools after initiating shutdown.

### Logger redacts secrets by default

The default logger (`defaultLogger()`) wraps console output with `withRedaction()`. Fields named `secretKey`, `privateKey`, `token`, `password`, `authorization`, and `cookie` are replaced with `[REDACTED]` in log context. Long hex strings (>200 chars) are also scrubbed.

---

## Recommended Upgrade Path

1. **Update the import** — replace `Store.memory()` with `createMemoryStore()`.
2. **Run your tests** — the deprecation warning is non-fatal, but fix it.
3. **Review rate limiting** — add `rateLimit: { enabled: false }` to test server configs if tests fail on rate limits.
4. **Check revenue assertions** — update any hardcoded expected values to account for 6-decimal precision.
5. **Opt into new features** — add `logger`, `webhooks`, `tracer` as needed.
