# API Stability

This document classifies every public export from `mpp-mcp-gateway` into one of three categories:

- **Stable** — committed public API. Breaking changes only in a major version bump.
- **Experimental** — likely to stabilize, but may change shape in a minor version.
- **Internal** — exported for advanced use cases but not covered by semver guarantees. May change or disappear in any release.

---

## Stable (committed public API)

### Core classes and factories

| Export | Sub-path | Description |
|--------|----------|-------------|
| `PaidMcpServer` | `/server` | The gateway server class |
| `createPaidMcpServer` | `/server` | Factory for `PaidMcpServer` |
| `PaidMcpClient` | `/client` | The payment-aware MCP client class |
| `createPaidMcpClient` | `/client` | Factory for `PaidMcpClient` |

### Types (all stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `PaidMcpServerConfig` | (types) | Server configuration |
| `PaidMcpClientConfig` | (types) | Client configuration |
| `PaidToolDefinition` | (types) | Tool definition shape |
| `PricingModel` | (types) | Discriminated union of pricing modes |
| `PricingTier` | (types) | Tiered pricing entry |
| `CurrencyOffer` | (types) | Multi-currency offer entry |
| `ToolHandlerResult` | (types) | What tool handlers return |
| `GatewayStats` | (types) | Stats shape returned by `getStats()` |
| `CallLogEntry` | (types) | Call log entry shape |
| `PaidCallResult` | (types) | Client-side tool call result |

### Error classes (all stable)

| Export | Description |
|--------|-------------|
| `MppMcpError` | Abstract base class |
| `ConfigurationError` | Bad config at construction |
| `ValidationError` | Invalid data at API boundary |
| `StoreError` | Storage operation failure |
| `SpendingCapExceededError` | Per-call or total cap breach |
| `SessionDepositCapExceededError` | Session deposit cap breach |
| `RateLimitExceededError` | Rate limit bucket exhausted |
| `ShuttingDownError` | Call rejected during shutdown |
| `ShutdownTimeoutError` | Drain didn't complete in time |
| `InternalError` | Invariant violation (bug) |
| `isMppMcpError` | Type guard function |
| `MppMcpErrorCode` | Union type of error code strings |

### Store adapters (all stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `MppMcpStore` | `/stores` | The four-method store interface |
| `createMemoryStore` | `/stores` | In-memory adapter |
| `createUpstashStore` | `/stores` | Upstash Redis adapter |
| `createCloudflareKvStore` | `/stores` | Cloudflare KV adapter |
| `bridgeMppxStore` | `/stores` | Legacy store bridge |
| `isMppMcpStore` | `/stores` | Type guard |
| `Store` | `/stores` | Convenience namespace (`Store.memory()`, etc.) |
| `UpstashRedisLike` | `/stores` | Minimal Redis client interface |
| `UpstashStoreOptions` | `/stores` | Upstash adapter config |
| `CloudflareKvLike` | `/stores` | Minimal KV namespace interface |
| `CloudflareKvStoreOptions` | `/stores` | Cloudflare KV adapter config |
| `LegacyThreeMethodStore` | `/stores` | Shape of old mppx stores |
| `StoreError` | `/stores` | Re-export from errors |

### Dashboard (stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `mountDashboard` | `/dashboard` | Mount JSON API endpoints |
| `DashboardOptions` | `/dashboard` | Config type |

### Discovery (stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `mountDiscovery` | `/discovery` | Mount OpenAPI endpoint |
| `buildOpenApi` | `/discovery` | Build OpenAPI doc programmatically |
| `DiscoveryOptions` | `/discovery` | Config type |
| `ServiceCategory` | `/discovery` | Category string union |

### Metrics (stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `mountMetrics` | `/metrics` | Mount Prometheus endpoint |
| `formatMetrics` | `/metrics` | Format metrics as Prometheus text |
| `PROMETHEUS_CONTENT_TYPE` | `/metrics` | Content-Type constant |
| `MetricsOptions` | `/metrics` | Config type |

### Auth middleware (stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `auth` | `/auth` | Namespace object |
| `bearerToken` | `/auth` | Bearer token middleware factory |
| `apiKey` | `/auth` | API key header middleware factory |
| `basicAuth` | `/auth` | HTTP Basic Auth middleware factory |
| `signedQuery` | `/auth` | HMAC signed-URL middleware factory |
| `publicCors` | `/auth` | Permissive CORS middleware factory |
| `BearerTokenOptions` | `/auth` | Config type |
| `ApiKeyOptions` | `/auth` | Config type |
| `BasicAuthOptions` | `/auth` | Config type |
| `SignedQueryOptions` | `/auth` | Config type |
| `PublicCorsOptions` | `/auth` | Config type |

### Rate limiting (stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `RateLimiter` | `/rate-limit` | Interface |
| `RateLimitResult` | `/rate-limit` | Result type |
| `tokenBucketLimiter` | `/rate-limit` | In-memory limiter factory |
| `upstashTokenBucketLimiter` | `/rate-limit` | Redis-backed limiter factory |
| `noopLimiter` | `/rate-limit` | Always-allow limiter |
| `TokenBucketOptions` | `/rate-limit` | Config type |
| `UpstashLimiterOptions` | `/rate-limit` | Config type |
| `RateLimitRedisLike` | `/rate-limit` | Minimal Redis interface (alias) |

### Logger (stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `Logger` | (logger) | Interface |
| `LogLevel` | (logger) | Level union type |
| `LogContext` | (logger) | Context record type |
| `consoleLogger` | (logger) | Console logger factory |
| `silentLogger` | (logger) | No-op logger factory |
| `arrayLogger` | (logger) | Test helper logger |
| `defaultLogger` | (logger) | Default (console + redaction) |
| `withRedaction` | (logger) | Redaction wrapper |
| `ConsoleLoggerOptions` | (logger) | Config type |
| `RedactionOptions` | (logger) | Redaction config type |
| `ArrayLogEntry` | (logger) | Captured entry type |

### Tracing (stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `startSpan` | `/tracing` | Start a span (or no-op) |
| `withSpan` | `/tracing` | Run fn inside a span |
| `ActiveSpan` | `/tracing` | Minimal span interface |
| `TRACE_ATTRS` | `/tracing` | Attribute key constants |
| `TRACE_SPANS` | `/tracing` | Span name constants |
| `SPAN_STATUS` | `/tracing` | Status code constants |

### Webhooks (stable)

| Export | Sub-path | Description |
|--------|----------|-------------|
| `WebhookDispatcher` | `/webhooks` | Dispatcher class |
| `createWebhookDispatcher` | `/webhooks` | Factory |
| `WebhookConfig` | `/webhooks` | Config type |
| `WebhookEvent` | `/webhooks` | Discriminated event union |
| `WebhookEventType` | `/webhooks` | Event type string union |
| `PaymentReceivedData` | `/webhooks` | Event data type |
| `AccessKeyIssuedData` | `/webhooks` | Event data type |
| `AccessKeyExpiredData` | `/webhooks` | Event data type |
| `SessionOpenedData` | `/webhooks` | Event data type |
| `SessionClosedData` | `/webhooks` | Event data type |
| `CallFailedData` | `/webhooks` | Event data type |

### Constants (stable)

| Export | Description |
|--------|-------------|
| `TEMPO_TESTNET` | Chain config (id, rpc, explorer) |
| `TEMPO_MAINNET` | Chain config |
| `TESTNET_TOKENS` | Token addresses (pathUSD, alphaUSD, betaUSD, thetaUSD) |
| `DEFAULT_CURRENCY` | Default token address |
| `TEMPO_ESCROW_TESTNET` | Escrow contract address |
| `TEMPO_ESCROW_MAINNET` | Escrow contract address |
| `DEFAULT_PORT` | Default port (3000) |
| `ACCESS_KEY_META` | MCP `_meta` key for access keys |

---

## Experimental

These exports are functional and tested, but their shape may change in a minor version:

| Export | Sub-path | Reason |
|--------|----------|--------|
| `CLOUDFLARE_KV_SESSION_WARNING` | `/stores` | May become a runtime validation rather than a string constant |

---

## Internal (exported but not covered by semver)

These are exported for power users who need to hook into library internals. They may change without warning in any release:

| Export | Sub-path | Reason |
|--------|----------|--------|
| `isNodeRuntime` | (runtime) | Runtime detection helper; edge cases may require signature changes |
| `randomHex` | (runtime) | Crypto utility; may move to a private module |
| `writeLogLine` | (runtime) | Log sink; may be internalized |

---

## Not Exported (intentionally internal)

These modules are used by the library but deliberately NOT exported from `index.ts` or any sub-path:

| Module | Reason |
|--------|--------|
| `src/access-keys.ts` | Implementation detail of access-key pricing. The `AccessKeyRecord` shape is embedded in store state — exposing it would make it impossible to change without a major bump. |
| `src/amounts.ts` | Internal BigInt math utilities. Not useful to consumers. |
| `src/runtime.ts` (most helpers) | Platform shims. Only 3 are re-exported for edge-specific use. |

---

## Semver Policy

Starting from the version that ships this document:

- **Patch** (0.x.Y): bug fixes, doc improvements, internal refactors with no public API change.
- **Minor** (0.X.0): new exports, new optional config fields, new event types. Nothing removed.
- **Major** (X.0.0): removed/renamed exports, changed type signatures, removed config fields.

Until `1.0.0` ships, minor versions may include breaking changes to **experimental** exports only. Stable exports follow semver strictly even pre-1.0.
