/**
 * mpp-mcp-gateway — OpenTelemetry tracing helpers
 *
 * Thin shim over `@opentelemetry/api` that lets the server emit
 * spans for every paid-tool call when (and only when) the operator
 * configures a tracer. When no tracer is supplied, every helper in
 * this module is a synchronous no-op — zero allocation, no
 * `await`, no observable cost. The point is that tracing has to be
 * cheap enough that we can leave the instrumentation in the hot
 * path.
 *
 * What we instrument:
 *
 *   - One root span per paid call: `mppmcp.tool.call`
 *     - Attributes: `mppmcp.tool.name`, `mppmcp.pricing.type`,
 *       `mppmcp.amount` (paid only), `mppmcp.payment.mode`,
 *       `mppmcp.access-key.just-issued` (issuance only),
 *       `mppmcp.payment.tx-hash` (after settlement),
 *       `mppmcp.session.action` (sessions only).
 *   - One child span per logical phase: `mppmcp.rate-limit`,
 *     `mppmcp.payment.charge`, `mppmcp.access-key.redeem`,
 *     `mppmcp.session.advance`, `mppmcp.handler.run`.
 *
 * What we DON'T instrument:
 *
 *   - Cross-boundary context propagation. The MCP wire format has
 *     no standard tracecontext header. Operators who want
 *     end-to-end tracing wire their own propagator into the MCP
 *     transport.
 *   - Sub-spans inside the user's handler. That's their domain;
 *     they call `trace.getActiveSpan()` and decorate themselves.
 *   - Metrics or logs through OTel. We have a Prometheus endpoint
 *     and a Logger interface already; doing the OTel dance for
 *     either would be redundant.
 *
 * Configuration:
 *
 * Pass a tracer in `PaidMcpServerConfig.tracer`. The tracer comes
 * from the user's own `TracerProvider` setup — typically:
 *
 * @example
 * ```ts
 * import { trace } from '@opentelemetry/api'
 * import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
 * import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
 *
 * const provider = new NodeTracerProvider()
 * provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()))
 * provider.register()
 *
 * const server = createPaidMcpServer({
 *     // ...
 *     tracer: trace.getTracer('my-gateway', '1.0.0'),
 * })
 * ```
 *
 * @module
 */

import type { Span, SpanStatusCode, Tracer } from '@opentelemetry/api'

/**
 * Span attribute keys. Centralized so tests and downstream
 * dashboards (Honeycomb queries, Grafana panels) can reference
 * stable strings instead of hardcoding them across files.
 */
export const TRACE_ATTRS = {
    TOOL_NAME: 'mppmcp.tool.name',
    PRICING_TYPE: 'mppmcp.pricing.type',
    AMOUNT: 'mppmcp.amount',
    PAYMENT_MODE: 'mppmcp.payment.mode',
    PAYMENT_TX_HASH: 'mppmcp.payment.tx-hash',
    ACCESS_KEY_JUST_ISSUED: 'mppmcp.access-key.just-issued',
    SESSION_ACTION: 'mppmcp.session.action',
    ERROR_CODE: 'mppmcp.error.code',
    BUCKET_KEY: 'mppmcp.rate-limit.bucket',
} as const

/**
 * Span name constants. Same rationale as {@link TRACE_ATTRS}.
 */
export const TRACE_SPANS = {
    TOOL_CALL: 'mppmcp.tool.call',
    RATE_LIMIT: 'mppmcp.rate-limit',
    PAYMENT_CHARGE: 'mppmcp.payment.charge',
    ACCESS_KEY_REDEEM: 'mppmcp.access-key.redeem',
    SESSION_ADVANCE: 'mppmcp.session.advance',
    HANDLER_RUN: 'mppmcp.handler.run',
} as const

/**
 * SpanStatusCode values (re-exported for convenience). The
 * OpenTelemetry API exports these as a const enum which TypeScript
 * inlines at compile time; we expose plain numeric constants here so
 * callers don't need to import from `@opentelemetry/api` directly
 * unless they want to.
 */
export const SPAN_STATUS = {
    OK: 1,
    ERROR: 2,
} as const

/**
 * A minimal recording-friendly span shape we control. Real OTel
 * spans implement this interface; the no-op span we return when
 * tracing is disabled also implements it but does nothing.
 *
 * Keeping the surface tiny means callers can treat the span as if
 * it always exists, without scattering `if (span)` checks through
 * the gateway.
 */
export interface ActiveSpan {
    /** Set or update an attribute on this span. */
    setAttribute(key: string, value: string | number | boolean): void
    /** Record an exception on this span without changing its status. */
    recordException(err: unknown): void
    /** Mark this span as failed and set its message. */
    setError(err: unknown): void
    /** Mark this span as successful. Equivalent to OK status. */
    setOk(): void
    /** End this span. After ending, further calls become no-ops. */
    end(): void
}

const NOOP_SPAN: ActiveSpan = Object.freeze({
    setAttribute() {
        /* no-op */
    },
    recordException() {
        /* no-op */
    },
    setError() {
        /* no-op */
    },
    setOk() {
        /* no-op */
    },
    end() {
        /* no-op */
    },
})

/**
 * Wrap a real OTel span in our {@link ActiveSpan} interface. Lifts
 * the OTel-specific status / exception API into our smaller shape.
 */
function wrapSpan(span: Span): ActiveSpan {
    let ended = false
    return {
        setAttribute(key, value) {
            if (ended) return
            span.setAttribute(key, value)
        },
        recordException(err) {
            if (ended) return
            span.recordException(asError(err))
        },
        setError(err) {
            if (ended) return
            const e = asError(err)
            span.recordException(e)
            // We can't directly use OTel's `SpanStatusCode.ERROR`
            // enum without importing it eagerly, which would defeat
            // the optional-peer-dep pattern. The numeric value of
            // `SpanStatusCode.ERROR` is 2 across all stable OTel
            // versions; using the literal here is safe and keeps
            // the import lazy.
            span.setStatus({ code: 2 as SpanStatusCode, message: e.message })
            const code = readErrorCode(err)
            if (code) span.setAttribute(TRACE_ATTRS.ERROR_CODE, code)
        },
        setOk() {
            if (ended) return
            span.setStatus({ code: 1 as SpanStatusCode })
        },
        end() {
            if (ended) return
            ended = true
            span.end()
        },
    }
}

/**
 * Start a new span via the supplied tracer, or return the no-op
 * span when no tracer is configured. The caller decides whether to
 * use it by simply calling its methods — no conditional ceremony.
 */
export function startSpan(
    tracer: Tracer | undefined,
    name: string,
    attributes: Record<string, string | number | boolean | undefined> = {}
): ActiveSpan {
    if (!tracer) return NOOP_SPAN
    const filtered: Record<string, string | number | boolean> = {}
    for (const [k, v] of Object.entries(attributes)) {
        if (v === undefined) continue
        filtered[k] = v
    }
    const span = tracer.startSpan(name, { attributes: filtered })
    return wrapSpan(span)
}

/**
 * Run `fn` inside a span and end the span when `fn` resolves or
 * throws. Sets `OK` on success and `ERROR` on failure with the
 * error's code attribute attached. Re-throws so caller-side
 * control-flow is unchanged.
 *
 * Use this when the span's lifetime exactly matches a function's
 * execution. For longer-lived spans (e.g. the root tool-call span
 * that crosses several phases), call {@link startSpan} directly
 * and end it yourself.
 */
export async function withSpan<T>(
    tracer: Tracer | undefined,
    name: string,
    fn: (span: ActiveSpan) => Promise<T>,
    attributes: Record<string, string | number | boolean | undefined> = {}
): Promise<T> {
    const span = startSpan(tracer, name, attributes)
    try {
        const result = await fn(span)
        span.setOk()
        return result
    } catch (err) {
        span.setError(err)
        throw err
    } finally {
        span.end()
    }
}

/**
 * @internal Coerce an unknown thrown value into an Error so OTel's
 * `recordException` always receives a usable shape.
 */
function asError(err: unknown): Error {
    if (err instanceof Error) return err
    return new Error(typeof err === 'string' ? err : 'Unknown error')
}

/**
 * @internal Read a structured error code if the value carries one.
 * Library errors set `code` (see `errors.ts`); other errors don't.
 */
function readErrorCode(err: unknown): string | undefined {
    if (typeof err !== 'object' || err === null) return undefined
    const candidate = (err as { code?: unknown }).code
    return typeof candidate === 'string' ? candidate : undefined
}
