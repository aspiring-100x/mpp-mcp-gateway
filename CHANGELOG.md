# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- API stability document (`docs/api-stability.md`) classifying all exports as stable, experimental, or internal.
- `@internal` JSDoc annotations on runtime utility exports (`randomHex`, `writeLogLine`, `isNodeRuntime`).
- `@experimental` annotation on `CLOUDFLARE_KV_SESSION_WARNING`.

---

## [0.5.0] - 2026-05-27

### Added
- **Multi-currency offers** — `accept` field on `per-call`, `session`, and `access-key` pricing models. Discovery emits N offers when set; backward compatible when omitted.
- **`CurrencyOffer` type** — exported from the barrel and types module.
- **Operator CLI** (`src/cli.ts`) — `inspect`, `stats`, `tools`, `calls`, `keys list` commands. `bin` entry: `npx mpp-mcp`.
- **Documentation suite** — 6 new docs:
  - `docs/production-checklist.md`
  - `docs/deployment-cloudflare-workers.md`
  - `docs/deployment-vercel.md`
  - `docs/deployment-fly-io.md`
  - `docs/architecture.md`
  - `docs/migration-from-0.1.md`
- **Cooperative session close** — `client.closeSession(toolName)` submits the latest voucher with `action: 'close'` for on-chain settlement.
- **Webhooks** — `WebhookDispatcher` with 6 event types (`payment.received`, `access-key.issued`, `access-key.expired`, `session.opened`, `session.closed`, `call.failed`), HMAC-SHA-256 signatures, retry with exponential backoff, drain support in graceful shutdown.

---

## [0.4.0] - 2026-05-27

### Added
- **OpenTelemetry tracing** — opt-in span tree per paid call (`mppmcp.tool.call` root with child spans for rate-limit, payment, access-key, session, handler phases). Zero overhead when `tracer` is not configured.
- **Prometheus `/metrics` endpoint** — `mountMetrics()` and `formatMetrics()`. 10 metric series covering calls, revenue, in-flight, access keys, sessions, uptime, and shutdown state.
- **Auth middleware** — 5 factories: `bearerToken`, `apiKey`, `basicAuth`, `signedQuery`, `publicCors`. Constant-time comparisons, proper `WWW-Authenticate` headers.
- **Edge runtime compatibility** — `src/runtime.ts` abstracts `randomHex`, `writeLogLine`, `hmacSha256Hex` over Web Crypto. Works on Cloudflare Workers, Vercel Edge, Deno Deploy, Bun, and Node 19+.

---

## [0.3.0] - 2026-05-27

### Added
- **Structured logging** — `Logger` interface + `consoleLogger`, `silentLogger`, `arrayLogger`, `withRedaction`. Pluggable via `PaidMcpServerConfig.logger` and `PaidMcpClientConfig.logger`. Default: JSON to stderr with automatic secret redaction.
- **Error taxonomy** — 9 typed error classes extending `MppMcpError` with stable `code` strings. `isMppMcpError` type guard.
- **Graceful shutdown** — `server.close()` with shutdown gate, in-flight drain, configurable timeout, `onShutdown` hook, and webhook drain.
- **Rate limiting** — `RateLimiter` interface + `tokenBucketLimiter` (in-memory), `upstashTokenBucketLimiter` (Redis), `noopLimiter`. Configurable via `PaidMcpServerConfig.rateLimit`.

---

## [0.2.0] - 2026-05-27

### Added
- **BigInt revenue tracking** — exact arithmetic via `usdStringToBaseUnits` / `baseUnitsToUsdString`. No more float drift after millions of sub-cent calls.
- **Atomic access-key redemption** — `MppMcpStore.update()` with CAS semantics. Concurrent redeems of a 50-call key produce exactly 50 successes.
- **Ring-buffer call log** — fixed-size circular buffer, O(1) append, configurable via `callLogSize`.
- **Three store adapters**:
  - `createMemoryStore()` — atomic via promise-chain serialization.
  - `createUpstashStore(redis)` — atomic via Lua-script CAS with retry.
  - `createCloudflareKvStore(namespace)` — best-effort (documented eventual consistency).
- **Store bridge** — `bridgeMppxStore()` wraps legacy three-method stores with a deprecation warning.

---

## [0.1.0] - 2026-05-26

### Added
- Initial release. `PaidMcpServer` and `PaidMcpClient` with per-call, tiered, session, and access-key pricing on Tempo testnet.
- Dashboard JSON API (`/api/stats`, `/api/tools`, `/api/calls`).
- Discovery endpoint (`/openapi.json` with `x-payment-info` per MPP spec).
- Dashboard React app (`dashboard/`).
- Examples: `paid-weather-mcp`, `paid-weather-http`, `paid-weather-sse`, `paid-streaming-mcp`, `paid-subscription-mcp`, `paid-weather-dashboard`, `in-memory-demo`.
