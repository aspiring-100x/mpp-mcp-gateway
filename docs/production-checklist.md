# Production Checklist

Run through this before going live. Each item addresses a real failure mode observed in early deployments.

---

## Secrets & Keys

- [ ] **`secretKey` is 32+ random characters.**
  Used for HMAC-binding 402 payment challenges. Short or predictable secrets let attackers forge challenges and steal payments.
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

- [ ] **`secretKey` is in an environment variable, not source.**
  Never commit it. Use your platform's secrets manager (Vercel env, Cloudflare secrets, Fly secrets, AWS SSM).

- [ ] **`privateKey` exists only in the client process.**
  The agent's signing key should never touch the server. If you're running both in the same repo, separate their env files.

- [ ] **Webhook `secret` is a separate 32+ char random string.**
  Distinct from `secretKey`. Receivers verify payloads with it — compromise means forged events.

---

## Store Configuration

- [ ] **Persistent store configured (not in-memory) for multi-instance.**
  The default `createMemoryStore()` loses state on restart and isn't shared across instances. For production:
  - **Upstash Redis** — recommended. Atomic CAS via Lua, works from edge runtimes.
  - **Cloudflare KV** — fine for access-key stores (eventual consistency is acceptable). Not safe for session channel state.

- [ ] **Session store is strongly consistent (if using session pricing).**
  Cloudflare KV's eventual consistency can cause divergent vouchers across regions. Use Upstash Redis or Durable Objects for session state.

- [ ] **Store key prefix set when sharing a database.**
  Multiple gateways on one Redis instance will collide without `keyPrefix`.

---

## Rate Limiting

- [ ] **Rate limiting is configured and reviewed for your traffic.**
  Default: 60 requests/minute/tool with in-memory token bucket. Review:
  - Is 60/min appropriate? High-traffic tools may need 600+.
  - Multi-instance? Switch to `upstashTokenBucketLimiter` so limits are enforced globally.
  - Per-session limiting? Pass a `keyExtractor` that includes the session ID.

- [ ] **Rate limiter shares state across instances (if load-balanced).**
  The in-memory bucket is per-process. Behind a load balancer, attackers can multiply their budget by N instances.

---

## Networking & TLS

- [ ] **HTTPS termination in front of the gateway.**
  MCP transport is unencrypted. Your reverse proxy (Cloudflare, nginx, Fly's anycast) must terminate TLS. Never expose the gateway directly over HTTP in production.

- [ ] **Dashboard and metrics endpoints are NOT publicly accessible.**
  They expose revenue, call patterns, and tool listings. Gate them with auth middleware:
  ```ts
  mountDashboard(server, app, {
      middleware: auth.bearerToken(process.env.DASHBOARD_TOKEN!),
  })
  mountMetrics(server, app, {
      middleware: auth.bearerToken(process.env.METRICS_TOKEN!),
  })
  ```

---

## Graceful Shutdown

- [ ] **Drain timeout matches your orchestrator's SIGTERM grace period.**
  Default: 30s. Kubernetes default `terminationGracePeriodSeconds` is also 30s, but the kubelet needs ~5s for its own cleanup. Set `drainTimeoutMs: 25_000` to leave headroom.

- [ ] **SIGTERM handler wired.**
  ```ts
  process.on('SIGTERM', async () => {
      try {
          await server.close({ timeoutMs: 25_000 })
          process.exit(0)
      } catch {
          process.exit(1)
      }
  })
  ```

- [ ] **`onShutdown` hook closes external connections.**
  Database pools, Redis clients, metric flush — close them in the hook so they drain before the process exits.

---

## Logging & Observability

- [ ] **Logger level set to `warn` or higher in production.**
  `debug` and `info` are noisy under load. Use `consoleLogger({ level: 'warn' })` unless actively debugging.

- [ ] **Tracing opt-in only in production.**
  Overhead is minimal but non-zero. Only enable `tracer` when you have a collector configured and need per-call visibility.

- [ ] **`callLogSize` tuned for your traffic.**
  Default: 1000 entries (ring buffer). High-volume servers may want more for audit. Low-memory edge deployments may want less.

---

## Webhooks

- [ ] **Webhook endpoint is HTTPS and responds within 5s.**
  Non-2xx responses trigger retry. Endpoints that hang burn the retry budget.

- [ ] **Webhook receiver verifies `X-MppMcp-Signature`.**
  ```ts
  const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET)
      .update(`${req.headers['x-mppmcp-timestamp']}.${req.body}`)
      .digest('hex')
  // Use timingSafeEqual for comparison.
  ```

- [ ] **Webhook events are filtered to what you need.**
  Default delivers all 6 event types. If you only care about revenue, subscribe to `['payment.received']` to reduce noise.

---

## Alerting (recommended)

- [ ] **Alert on stuck shutdown.**
  ```
  mppmcp_shutting_down == 1 for 30s
  ```
  Means the drain timed out or the process is stuck.

- [ ] **Alert on zero paid traffic.**
  ```
  rate(mppmcp_calls_by_mode_total{mode="paid"}[5m]) == 0
  ```
  If you expect continuous traffic, silence means something broke.

- [ ] **Alert on high rate-limit denials.**
  If you add a counter for rate-limited calls (v0.5), alert on sustained spikes — could indicate an attack or a misconfigured limit.

---

## Network & Currency

- [ ] **Correct network selected (`mainnet` vs `testnet`).**
  Default is `testnet`. Deploying with testnet tokens in production means free calls for everyone.

- [ ] **`recipient` address is a wallet you control on the correct network.**
  Double-check the chain ID. Funds sent to a testnet address on mainnet (or vice versa) may be unrecoverable.

---

## Discovery

- [ ] **`baseUrl` set in discovery options.**
  Without it, registries can crawl by host but `servers[]` is omitted from the OpenAPI document — some clients won't know where to connect.

- [ ] **Discovery endpoint public (with CORS) if you want registry indexing.**
  ```ts
  mountDiscovery(server, app, {
      middleware: auth.publicCors(),
      baseUrl: 'https://api.example.com',
  })
  ```

---

## Final Sanity

- [ ] **Build passes cleanly.** `npm run build`
- [ ] **Tests pass.** `npm test`
- [ ] **Smoke test: call a tool and verify payment settles.**
  Use the example client against your deployed server with a small amount.
- [ ] **Check `/metrics` returns Prometheus text format.**
- [ ] **Check `/api/stats` returns JSON (behind auth).**
