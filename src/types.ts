/**
 * mpp-mcp-gateway — types
 *
 * Core types for monetizing MCP tools with MPP micropayments on Tempo.
 */

import type { Tracer } from '@opentelemetry/api'
import type { z } from 'zod'

import type { Logger } from './logger.js'
import type { RateLimiter } from './rate-limit.js'
import type { WebhookConfig } from './webhooks.js'

/**
 * A currency-specific price offer. Used in the `accept` array to
 * advertise that a tool accepts multiple TIP-20 stablecoins at
 * potentially different amounts.
 */
export interface CurrencyOffer {
    /** TIP-20 token contract address. */
    currency: `0x${string}`
    /** Price in that currency as a USD-equivalent decimal string. */
    amount: string
}

/** Pricing model for a paid MCP tool. */
export type PricingModel =
    | {
        type: 'per-call'
        amount: string
        /**
         * Optional multi-currency acceptance. When set, the discovery
         * endpoint advertises one offer per entry (in addition to or
         * instead of the server-level default currency). Backward
         * compatible: if omitted, behavior is unchanged.
         */
        accept?: CurrencyOffer[]
    }
    | { type: 'tiered'; tiers: PricingTier[] }
    | {
        /**
         * Session pricing — pay-as-you-go via an off-chain payment channel.
         *
         * The agent opens an on-chain escrow channel once, then signs cumulative
         * vouchers per call. The server settles the highest voucher on channel
         * close. Best for streaming or high-frequency tool use where per-call
         * on-chain settlement would be too slow or expensive.
         */
        type: 'session'
        /**
         * Per-unit price as a USD decimal string, e.g. `'0.0001'`.
         * One unit is consumed per tool call by default.
         */
        amount: string
        /**
         * Free-form unit identifier, e.g. `'request'`, `'second'`, `'token'`.
         * Advertised to the client in the challenge — informational only.
         */
        unitType: string
        /**
         * Hint to the client about how much to fund the channel with on open.
         * The client may cap this with its own `maxSessionDeposit`.
         * @default '1.00'
         */
        suggestedDeposit?: string
        /**
         * Smallest voucher delta the server will accept, as a USD decimal
         * string. Helps prevent dust-spam vouchers. Defaults to `amount`.
         */
        minVoucherDelta?: string
        /**
         * Optional multi-currency acceptance. When set, the discovery
         * endpoint advertises one offer per entry. Backward compatible:
         * if omitted, behavior is unchanged.
         */
        accept?: CurrencyOffer[]
    }
    | {
        /**
         * Access-key pricing — agent pays an upfront fee once and receives an
         * opaque key. Subsequent calls present the key in metadata and bypass
         * payment until the key is exhausted (max-calls) or expires (validFor).
         *
         * Best for subscription-style access patterns where many calls share
         * a single payment. Differs from sessions: there's no on-chain channel,
         * no incremental vouchers, and no settlement step. Just a one-shot
         * Tempo `charge` followed by a server-stored authorization token.
         *
         * At least one of `validFor` or `maxCalls` must be set.
         */
        type: 'access-key'
        /**
         * Upfront cost in USD as a decimal string, e.g. `'1.00'`.
         */
        amount: string
        /**
         * How long the key remains valid after issuance. Compact format:
         * `'60s'`, `'30m'`, `'4h'`, `'7d'`, `'30d'`. Omit for an unlimited-
         * time key bounded only by `maxCalls`.
         */
        validFor?: string
        /**
         * How many calls the key authorizes. Decremented on each successful
         * call. When the counter hits zero the server invalidates the key.
         * Omit for an unlimited-call key bounded only by `validFor`.
         */
        maxCalls?: number
        /**
         * Optional multi-currency acceptance. When set, the discovery
         * endpoint advertises one offer per entry. Backward compatible:
         * if omitted, behavior is unchanged.
         */
        accept?: CurrencyOffer[]
    }

export interface PricingTier {
    /** Calls up to this count use this price. Use 'unlimited' for the last tier. */
    upTo: number | 'unlimited'
    /** Price in this tier (USD as a decimal string, e.g. "0.01"). */
    amount: string
}

/** Definition of a paid tool. */
export interface PaidToolDefinition {
    /** Tool name (must be a valid MCP tool identifier). */
    name: string
    /** Human-readable description shown to agents. */
    description: string
    /** Zod schema for the tool's input arguments. */
    inputSchema: Record<string, z.ZodTypeAny>
    /** Pricing. Omit for a free tool. */
    pricing?: PricingModel
    /** Implementation: called after payment is verified. */
    handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> | ToolHandlerResult
}

/** What a tool handler returns — a simple text or structured content. */
export interface ToolHandlerResult {
    content: Array<{ type: 'text'; text: string }>
    /** Optional structured data (e.g. JSON). */
    data?: unknown
}

/** Configuration for creating a paid MCP server. */
export interface PaidMcpServerConfig {
    /** Server name (advertised to clients). */
    name: string
    /** Server version. */
    version: string
    /** Wallet address receiving payments. */
    recipient: `0x${string}`
    /** TIP-20 stablecoin used for pricing. Defaults to pathUSD on testnet. */
    currency?: `0x${string}`
    /** Network — defaults to testnet. */
    network?: 'mainnet' | 'testnet'
    /** Required: secret key for HMAC-binding payment challenges. */
    secretKey: string
    /** Tools to register. */
    tools: PaidToolDefinition[]
    /**
     * Optional private key for fee sponsorship — the server pays gas on behalf
     * of clients. When set, clients can send signed (but not broadcast)
     * transactions and the server broadcasts them itself.
     */
    feePayerKey?: `0x${string}`
    /**
     * Escrow contract address for session pricing. Required only if any tool
     * uses `pricing.type === 'session'`. Falls back to mppx's per-network
     * defaults (`TEMPO_ESCROW_*` in `constants.ts`) when omitted.
     */
    escrowContract?: `0x${string}`
    /**
     * Pluggable channel-state store for session pricing. Defaults to an
     * in-memory store. Replace with a Redis/D1/Durable-Object backed store
     * for multi-process or load-balanced deployments.
     */
    sessionStore?: unknown
    /**
     * Pluggable store for access-key authorization tokens. Defaults to an
     * in-memory store. Replace with a Redis/D1/Durable-Object backed store
     * for multi-process or load-balanced deployments. Must implement the
     * mppx `Store` interface (get / put / delete).
     */
    accessKeyStore?: unknown
    /**
     * Access-key binding mode. Controls whether issued access keys are
     * bound to the paying client's identity, preventing replay attacks
     * if a key is intercepted on an unencrypted transport.
     *
     * - `'none'` (default) — keys are bearer tokens; any presenter is
     *   authorized. Simplest, backward-compatible.
     * - `'wallet'` — keys are bound to the wallet address that paid the
     *   upfront fee. Subsequent redemption requests must carry the same
     *   wallet address in `_meta['org.mppmcp/access-key-fingerprint']`.
     *   The client SDK handles this automatically.
     *
     * @default 'none'
     */
    accessKeyBinding?: 'none' | 'wallet'
    /**
     * Maximum number of recent calls to retain in the call-log ring buffer.
     * The dashboard's `/api/calls` endpoint pulls from this buffer.
     * Set to `0` to disable per-call logging entirely.
     * @default 1000
     */
    callLogSize?: number
    /**
     * Optional structured logger. The library uses this for runtime
     * events (access-key issuance, session lifecycle, internal errors).
     * Defaults to a console logger that writes JSON to stderr with
     * automatic redaction of sensitive fields. Pass `silentLogger()`
     * for tests and silent production deployments, or a custom adapter
     * built on pino, winston, or your platform's logging stack.
     */
    logger?: Logger
    /**
     * Default drain timeout for {@link PaidMcpServer.close}, in
     * milliseconds. The default of 30 seconds matches typical
     * Kubernetes `terminationGracePeriodSeconds` minus a buffer for
     * Pod cleanup.
     *
     * Per-call overrides via `close({ timeoutMs })` always win over
     * this default.
     *
     * @default 30_000
     */
    drainTimeoutMs?: number
    /**
     * Optional callback invoked once when {@link PaidMcpServer.close}
     * begins, before the gateway starts draining in-flight calls.
     *
     * Use it to start your own cleanup work in parallel (close
     * database connections, flush metrics, finalize webhook batches).
     * The hook may return a promise; `close()` awaits it before
     * returning, but the drain timer runs concurrently — long-running
     * cleanup must finish within the drain budget or `close()` resolves
     * before your hook does.
     *
     * Throwing or rejecting from the hook is logged at `error` level
     * but does not abort the shutdown.
     */
    onShutdown?: () => void | Promise<void>
    /**
     * Rate-limit configuration. By default the gateway throttles
     * each tool to a sustained 60 requests/minute with a burst
     * capacity of 60, scoped per-tool. This protects servers from
     * cheap-to-issue, expensive-to-fulfill request floods that don't
     * require the attacker to pay.
     *
     * Set `enabled: false` to disable rate limiting entirely
     * (recommended only for tests and trusted environments). Pass a
     * custom `limiter` to swap in `upstashTokenBucketLimiter` for
     * multi-instance deployments. Provide `keyExtractor` to bucket
     * by something other than tool name — e.g. session id on HTTP
     * transports.
     */
    rateLimit?: {
        /**
         * Whether rate limiting runs at all. When `false`, every
         * call is allowed regardless of other rate-limit settings.
         * @default true
         */
        enabled?: boolean
        /**
         * Custom limiter implementation. When omitted, the gateway
         * builds an in-memory token bucket using
         * `refillPerMinute` and `capacity`.
         */
        limiter?: RateLimiter
        /**
         * Sustained refill rate, in tokens per minute, for the
         * default in-memory limiter. Ignored when `limiter` is set.
         * @default 60
         */
        refillPerMinute?: number
        /**
         * Burst capacity for the default in-memory limiter. Ignored
         * when `limiter` is set.
         * @default equals refillPerMinute
         */
        capacity?: number
        /**
         * Function that extracts the bucket key from the tool name
         * and the MCP request `extra`. Default keys by tool name.
         *
         * For HTTP/SSE transports where session ids are useful,
         * pass `(toolName, extra) => extra.sessionId ?? toolName`.
         * Custom extractors can compose ids: e.g.
         * `${toolName}:${sessionId}` for per-tool-per-session
         * limits.
         */
        keyExtractor?: (
            toolName: string,
            extra: Record<string, unknown>
        ) => string
        /**
         * Per-tool rate limit overrides. Keys are tool names; values
         * specify `refillPerMinute` and/or `capacity` for that specific
         * tool. Tools not listed here fall back to the server-wide
         * `refillPerMinute` and `capacity`. Ignored when a custom
         * `limiter` is provided (since the operator owns the entire
         * rate-limit implementation in that case).
         *
         * Useful when an expensive tool ($10/call) needs a tighter
         * limit than a cheap one ($0.001/call):
         *
         * @example
         * ```ts
         * rateLimit: {
         *     refillPerMinute: 60,       // default: 60/min
         *     perTool: {
         *         'expensive_ai':  { refillPerMinute: 5, capacity: 2 },
         *         'cheap_lookup':  { refillPerMinute: 600, capacity: 100 },
         *     },
         * }
         * ```
         */
        perTool?: Record<string, {
            /** Sustained refill rate for this tool, in tokens per minute. */
            refillPerMinute?: number
            /** Burst capacity for this tool. */
            capacity?: number
        }>
    }
    /**
     * Optional OpenTelemetry tracer. When provided, the gateway
     * emits a span tree for every paid-tool call: a root
     * `mppmcp.tool.call` span with child spans for rate-limit,
     * payment, access-key redemption / issuance, session advance,
     * and handler execution. Span attributes carry tool name,
     * pricing type, payment mode, and (when applicable) tx hash.
     *
     * Tracing is **off by default** — only paid calls in
     * production deployments typically warrant the cost. Construct
     * a tracer through your OTel SDK setup and pass it here:
     *
     * ```ts
     * import { trace } from '@opentelemetry/api'
     * tracer: trace.getTracer('mpp-mcp-gateway')
     * ```
     *
     * The library imports `@opentelemetry/api` only as a type;
     * users opt in by installing it themselves. With no tracer
     * configured, every tracing helper is a synchronous no-op so
     * non-traced deployments pay zero cost.
     */
    tracer?: Tracer
    /**
     * Optional webhook configuration. When set, the gateway
     * pushes events (`payment.received`, `access-key.issued`,
     * `session.opened`, `session.closed`, `access-key.expired`,
     * `call.failed`) to the configured URL with HMAC-SHA-256
     * signatures.
     *
     * Delivery is fire-and-forget: tool-call latency is
     * unaffected by webhook receiver behavior. Events that fail
     * delivery after the configured retry budget are logged at
     * `error` level and dropped — there's no on-disk persistence.
     * For durable delivery, mirror this against your own queue
     * (Postgres, Redis Streams, SQS).
     *
     * See {@link WebhookConfig} for the full configuration shape
     * and {@link WebhookEvent} for the wire format.
     */
    webhooks?: WebhookConfig
}

/** Configuration for creating a payment-enabled MCP client. */
export interface PaidMcpClientConfig {
    /** Client name (advertised to servers). */
    name: string
    /** Client version. */
    version: string
    /** Agent's private key for signing payment transactions. */
    privateKey: `0x${string}`
    /** Max amount willing to pay for a single tool call (safety cap). */
    maxPerCall?: string
    /** Max total amount the agent can spend (safety cap). */
    maxTotal?: string
    /**
     * Max amount the agent will deposit into a session channel on open, as
     * a USD decimal string. Caps the server's `suggestedDeposit`.
     * @default '1.00'
     */
    maxSessionDeposit?: string
    /** Network — defaults to testnet. */
    network?: 'mainnet' | 'testnet'
    /**
     * Optional structured logger. Used for client-side events
     * (cap-exceeded warnings, payment retries, internal errors).
     * Defaults to a console logger that writes JSON to stderr with
     * automatic redaction of sensitive fields.
     */
    logger?: Logger
    /**
     * Whether to verify session settlement transactions on-chain
     * after `closeSession()` returns. When enabled, the client
     * watches for the settlement tx confirmation on the escrow
     * contract before marking the close as complete.
     *
     * - `true` — verify via RPC that the tx hash in the receipt is
     *   confirmed and the escrow event matches the channel state.
     *   Adds ~1-2s latency to `closeSession()` but provides
     *   trustless guarantees.
     * - `false` (default) — trust the server's receipt. Faster,
     *   suitable for trusted server relationships.
     *
     * @default false
     */
    verifySettlement?: boolean
}

/** Runtime statistics for a paid MCP server. */
export interface GatewayStats {
    totalCalls: number
    paidCalls: number
    freeCalls: number
    /** Calls served against an open session channel. */
    sessionCalls: number
    /** Calls served against a valid access key (no payment required). */
    accessKeyCalls: number
    totalRevenue: string
    callsByTool: Record<string, number>
    revenueByTool: Record<string, string>
    /** Number of session channels opened over the server's lifetime. */
    sessionsOpened: number
    /** Number of session channels closed (settled) over the server's lifetime. */
    sessionsClosed: number
    /** Number of access keys issued over the server's lifetime. */
    accessKeysIssued: number
    /** Number of access keys revoked because they expired or hit their call cap. */
    accessKeysExpired: number
    /**
     * Number of calls rejected by the rate limiter before any payment or
     * handler logic ran. Surfaced as `mppmcp_rate_limited_total` in metrics.
     */
    rateLimitedCalls: number
    /**
     * Number of calls rejected because the gateway had begun shutting down.
     * Surfaced as `mppmcp_rejected_shutting_down_total` in metrics.
     */
    rejectedShuttingDown: number
    uptimeMs: number
    startedAt: string
}

/**
 * A live access-key record as surfaced by the server's `/api/keys`
 * endpoint and {@link "mpp-mcp-gateway".PaidMcpServer.listAccessKeys}.
 */
export interface AccessKeyListEntry {
    /** Opaque access-key token. */
    key: string
    /** Tool the key authorizes. */
    tool: string
    /** ISO 8601 timestamp when the key was issued. */
    issuedAt: string
    /** ISO 8601 timestamp when the key expires, if `validFor` was set. */
    expiresAt?: string
    /** Calls remaining, if `maxCalls` was set. */
    remainingCalls?: number
    /** Wallet address the key is bound to, when `accessKeyBinding: 'wallet'`. */
    boundTo?: string
}

/** A single entry in the server's recent-call log (used by the dashboard). */
export interface CallLogEntry {
    /** Tool that was invoked. */
    tool: string
    /** ISO 8601 timestamp when the call completed. */
    timestamp: string
    /** Wall-clock duration of the handler, in milliseconds. */
    durationMs: number
    /** Whether the call required on-chain payment (true) or was free / cached (false). */
    paid: boolean
    /**
     * Pricing mode the call resolved to: `'free'`, `'per-call'`, `'tiered'`,
     * `'session'`, `'access-key'`, or `'access-key-cached'` for an
     * authorization that did not pay.
     */
    paymentMode:
    | 'free'
    | 'per-call'
    | 'tiered'
    | 'session'
    | 'access-key'
    | 'access-key-cached'
    /** Charged amount in USD as a decimal string, when `paid` is true. */
    amount?: string
    /** True if this call minted a fresh access key. */
    accessKeyJustIssued?: boolean
    /** Error message if the call ended in failure (non-payment errors only). */
    error?: string
}

/** The outcome of a client tool call. */
export interface PaidCallResult<T = unknown> {
    /** The tool's content (text blocks). */
    content: Array<{ type: 'text'; text: string }>
    /** The optional structured result. */
    data?: T
    /** The payment receipt, present when the call required payment. */
    receipt?: {
        method: string
        reference: string // tx hash
        timestamp: string
        amount?: string
    }
    /** Whether this call required payment. */
    paid: boolean
    /**
     * If the call was authorized by an access key (either issued by this call
     * or cached from a previous one), the key's current state.
     */
    accessKey?: {
        /** Opaque token. Cache it on the client and present it on next call. */
        key: string
        /** ISO 8601 timestamp when the key expires, if `validFor` was set. */
        expiresAt?: string
        /** Calls remaining, if `maxCalls` was set. */
        remainingCalls?: number
        /** True when this call was the one that minted the key. */
        justIssued: boolean
    }
}
