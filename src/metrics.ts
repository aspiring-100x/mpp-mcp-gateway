/**
 * mpp-mcp-gateway — Prometheus metrics
 *
 * Mounts a `/metrics` endpoint on an Express app. The output follows
 * the Prometheus text exposition format (version 0.0.4) with the
 * appropriate `Content-Type` header so any compliant scraper —
 * Prometheus, VictoriaMetrics, Grafana Agent, OpenTelemetry's
 * Prometheus receiver — picks it up natively.
 *
 * What we expose:
 *
 *   - `mppmcp_calls_total{tool, mode}` — counter — call counts by
 *     tool and payment mode (per-call, free, session, access-key).
 *   - `mppmcp_revenue_micro_usd_total{tool}` — counter — cumulative
 *     revenue per tool in micro-USD (10⁻⁶ USD). Integer-valued so
 *     it survives Prometheus's float serialization without drift.
 *   - `mppmcp_revenue_micro_usd_total` — counter — server-wide
 *     revenue (no labels).
 *   - `mppmcp_in_flight_calls` — gauge — currently active handlers.
 *   - `mppmcp_access_keys_issued_total` — counter.
 *   - `mppmcp_access_keys_expired_total` — counter.
 *   - `mppmcp_sessions_opened_total` — counter.
 *   - `mppmcp_sessions_closed_total` — counter.
 *   - `mppmcp_uptime_seconds` — gauge — server uptime.
 *
 * What we don't expose (yet):
 *
 *   - Per-tool latency histograms. Histograms add bucket-count
 *     overhead and the right bucket boundaries depend on the user's
 *     SLO. We surface raw `durationMs` in the call log; users
 *     building dashboards can compute their own quantiles or
 *     translate via OpenTelemetry. Histograms are a v0.5 candidate.
 *
 *   - Counters for shutdown / rate-limited / cap-exceeded events.
 *     These would be valuable but require persistent counters in
 *     the server's state, not derivable from `getStats()`. v0.5.
 *
 * Why no `prom-client` dependency?
 *
 * The Prometheus text format is straightforward and we don't use
 * histograms or summaries here. Adding a 600KB-ish runtime
 * dependency for what amounts to ~50 lines of formatting would be
 * gratuitous. Hand-formatting also keeps us runtime-portable: users
 * deploying to edge runtimes can call `formatMetrics(server)`
 * directly and serve it through their platform's native router.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { createPaidMcpServer, mountMetrics, auth } from 'mpp-mcp-gateway'
 *
 * const server = createPaidMcpServer({ ... })
 * const app = express()
 *
 * mountMetrics(server, app, {
 *     middleware: auth.bearerToken(process.env.METRICS_TOKEN!),
 * })
 * // GET /metrics → Prometheus text
 * ```
 *
 * @example edge runtime — Cloudflare Worker
 * ```ts
 * import { formatMetrics } from 'mpp-mcp-gateway/metrics'
 *
 * if (url.pathname === '/metrics') {
 *     return new Response(formatMetrics(server), {
 *         headers: { 'Content-Type': PROMETHEUS_CONTENT_TYPE },
 *     })
 * }
 * ```
 *
 * @module
 */

import type { Express, RequestHandler, Router } from 'express'

import { usdStringToBaseUnits } from './amounts.js'
import type { PaidMcpServer } from './server.js'

/**
 * The Content-Type required by the Prometheus exposition format
 * version 0.0.4. Re-exported for users formatting metrics outside
 * the Express path (e.g. Cloudflare Worker handlers).
 *
 * @see https://prometheus.io/docs/instrumenting/exposition_formats/
 */
export const PROMETHEUS_CONTENT_TYPE =
    'text/plain; version=0.0.4; charset=utf-8'

export interface MetricsOptions {
    /**
     * URL path the metrics document is served at.
     * @default '/metrics'
     */
    path?: string

    /**
     * Optional middleware applied to the metrics route — handy for
     * wiring auth (so internal-only metrics aren't crawled
     * publicly), rate limiting, or origin restrictions.
     */
    middleware?: RequestHandler | RequestHandler[]

    /**
     * Whether to emit per-tool revenue metrics. When you have
     * many tools (>1000), per-tool labels can blow up Prometheus
     * cardinality. Disable this in those scenarios; the
     * server-wide `mppmcp_revenue_micro_usd_total` counter
     * remains.
     * @default true
     */
    perToolRevenue?: boolean

    /**
     * Whether to emit per-tool call counters. Same cardinality
     * concern as `perToolRevenue`.
     * @default true
     */
    perToolCalls?: boolean
}

/**
 * Mount the `/metrics` route on an existing Express app or Router.
 * Adds a single GET handler. Returns the same app for chaining.
 *
 * Use {@link formatMetrics} directly if you're outside Express.
 */
export function mountMetrics(
    server: PaidMcpServer,
    app: Express | Router,
    options: MetricsOptions = {}
): Express | Router {
    const path = options.path ?? '/metrics'
    const middleware = normalizeMiddleware(options.middleware)

    const handler: RequestHandler = (_req, res) => {
        const body = formatMetrics(server, options)
        res.set('Content-Type', PROMETHEUS_CONTENT_TYPE)
        // Prometheus scrapers don't cache, but proxies might.
        // Tell them not to.
        res.set('Cache-Control', 'no-store')
        res.send(body)
    }

    const get = app.get.bind(app) as (
        path: string,
        ...handlers: RequestHandler[]
    ) => unknown
    get(path, ...middleware, handler)

    return app
}

/**
 * Format the server's current state as a Prometheus exposition
 * document. Pure function — call it from any context (Express,
 * Worker, Lambda, test) to produce the same output.
 *
 * The document includes HELP and TYPE comments per metric, plus
 * label-keyed sample lines. Strings in label values are escaped
 * per spec.
 */
export function formatMetrics(
    server: PaidMcpServer,
    options: Pick<MetricsOptions, 'perToolCalls' | 'perToolRevenue'> = {}
): string {
    const stats = server.getStats()
    const inFlight = server.getInFlightCount()
    const perToolCalls = options.perToolCalls ?? true
    const perToolRevenue = options.perToolRevenue ?? true
    const lines: string[] = []

    // ---- Calls by tool / mode -------------------------------------
    lines.push(
        '# HELP mppmcp_calls_total Total tool calls grouped by tool name.',
        '# TYPE mppmcp_calls_total counter'
    )
    if (perToolCalls && Object.keys(stats.callsByTool).length > 0) {
        for (const [tool, count] of Object.entries(stats.callsByTool)) {
            lines.push(
                `mppmcp_calls_total{tool=${labelValue(tool)}} ${count}`
            )
        }
    }
    // Aggregate counters by payment mode — separate metric series
    // with its own HELP/TYPE headers per Prometheus exposition rules.
    lines.push(
        '# HELP mppmcp_calls_by_mode_total Total tool calls grouped by payment mode.',
        '# TYPE mppmcp_calls_by_mode_total counter',
        `mppmcp_calls_by_mode_total{mode="paid"} ${stats.paidCalls}`,
        `mppmcp_calls_by_mode_total{mode="free"} ${stats.freeCalls}`,
        `mppmcp_calls_by_mode_total{mode="session"} ${stats.sessionCalls}`,
        `mppmcp_calls_by_mode_total{mode="access_key"} ${stats.accessKeyCalls}`,
        `mppmcp_calls_by_mode_total{mode="total"} ${stats.totalCalls}`
    )

    // ---- Revenue --------------------------------------------------
    // Convert decimal-string USD to micro-USD (integer base units
    // with 6 decimals — matches Tempo TIP-20 stablecoin convention
    // and Prometheus's preference for integer counters).
    lines.push(
        '# HELP mppmcp_revenue_micro_usd_total Cumulative revenue in micro-USD (1 micro-USD = 1e-6 USD).',
        '# TYPE mppmcp_revenue_micro_usd_total counter',
        `mppmcp_revenue_micro_usd_total ${revenueToMicroUsd(stats.totalRevenue)}`
    )
    if (perToolRevenue && Object.keys(stats.revenueByTool).length > 0) {
        for (const [tool, amount] of Object.entries(stats.revenueByTool)) {
            lines.push(
                `mppmcp_revenue_micro_usd_total{tool=${labelValue(tool)}} ${revenueToMicroUsd(amount)}`
            )
        }
    }

    // ---- In-flight gauge ------------------------------------------
    lines.push(
        '# HELP mppmcp_in_flight_calls Tool calls currently being processed.',
        '# TYPE mppmcp_in_flight_calls gauge',
        `mppmcp_in_flight_calls ${inFlight}`
    )

    // ---- Access keys ----------------------------------------------
    lines.push(
        '# HELP mppmcp_access_keys_issued_total Access keys minted over the server lifetime.',
        '# TYPE mppmcp_access_keys_issued_total counter',
        `mppmcp_access_keys_issued_total ${stats.accessKeysIssued}`,
        '# HELP mppmcp_access_keys_expired_total Access keys revoked due to expiry or exhaustion.',
        '# TYPE mppmcp_access_keys_expired_total counter',
        `mppmcp_access_keys_expired_total ${stats.accessKeysExpired}`
    )

    // ---- Sessions -------------------------------------------------
    lines.push(
        '# HELP mppmcp_sessions_opened_total Session channels opened.',
        '# TYPE mppmcp_sessions_opened_total counter',
        `mppmcp_sessions_opened_total ${stats.sessionsOpened}`,
        '# HELP mppmcp_sessions_closed_total Session channels settled.',
        '# TYPE mppmcp_sessions_closed_total counter',
        `mppmcp_sessions_closed_total ${stats.sessionsClosed}`
    )

    // ---- Uptime ---------------------------------------------------
    lines.push(
        '# HELP mppmcp_uptime_seconds Server uptime in seconds.',
        '# TYPE mppmcp_uptime_seconds gauge',
        `mppmcp_uptime_seconds ${(stats.uptimeMs / 1000).toFixed(3)}`
    )

    // ---- Shutdown signal ------------------------------------------
    // 1 if the server is in the middle of `close()`, else 0. Useful
    // for alerting on stuck shutdowns.
    lines.push(
        '# HELP mppmcp_shutting_down 1 if the gateway has begun graceful shutdown, else 0.',
        '# TYPE mppmcp_shutting_down gauge',
        `mppmcp_shutting_down ${server.isShuttingDown() ? 1 : 0}`
    )

    // Trailing newline is required by the spec — scrapers that
    // care about line-counting will reject documents without one.
    return lines.join('\n') + '\n'
}

// -------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------

/**
 * @internal Convert a USD decimal string (e.g. `'0.001000'`) to its
 * micro-USD integer (e.g. `1000`). Reuses the BigInt-based helper
 * that powers revenue tracking so the conversion is exact and
 * matches the value the server already accumulates internally.
 *
 * Returns `'0'` for the canonical zero case. Anything else
 * round-trips through 6-decimal base units. We emit the result as
 * a string (not a JS number) to avoid float coercion when the
 * value approaches `Number.MAX_SAFE_INTEGER` — Prometheus parses
 * numeric strings without round-tripping through JS Number.
 */
function revenueToMicroUsd(amount: string): string {
    if (amount === '0' || amount === '') return '0'
    return usdStringToBaseUnits(amount, 6).toString()
}

/**
 * @internal Format a label value per the Prometheus text format:
 * double-quoted, with `\` and `"` and `\n` escaped. Most tool
 * names are simple identifiers and don't need escaping, but we
 * handle the general case so misbehaving tool names can't break
 * the document.
 *
 * @see https://prometheus.io/docs/instrumenting/exposition_formats/#text-format-details
 */
function labelValue(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** @internal Normalize the middleware option to an always-array shape. */
function normalizeMiddleware(
    m: MetricsOptions['middleware']
): RequestHandler[] {
    if (!m) return []
    return Array.isArray(m) ? m : [m]
}
