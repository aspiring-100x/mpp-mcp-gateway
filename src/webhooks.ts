/**
 * mpp-mcp-gateway — webhooks
 *
 * Push events from the gateway to a configured URL whenever
 * something interesting happens: a payment settles, an access key
 * is issued, a session channel opens or closes, a call fails for a
 * non-payment reason. Operators subscribe instead of polling.
 *
 * Wire shape (Stripe-compatible, by intention):
 *
 *   - POST to the configured URL with `Content-Type: application/json`
 *   - JSON body: `{ id, type, createdAt, data }` — `id` is a fresh
 *     ULID-shaped identifier, `type` is the event name, `createdAt`
 *     is ISO 8601, `data` is event-specific.
 *   - Header `X-MppMcp-Timestamp: <unix-seconds>` — issuance time.
 *   - Header `X-MppMcp-Signature: sha256=<hex>` — HMAC-SHA-256 of
 *     `${timestamp}.${body}` using the shared secret. Verifying
 *     this on the receiver protects against forged or replayed
 *     events.
 *   - Header `X-MppMcp-Event: <type>` — duplicates the body's `type`
 *     for receivers that route by header.
 *
 * Delivery semantics:
 *
 *   - **Fire and forget.** The tool call's response doesn't wait
 *     for webhook delivery. A slow or failing webhook endpoint
 *     never affects user-visible latency or correctness. This is
 *     the only sane default — making delivery synchronous would
 *     couple every paid call to the operator's webhook URL.
 *
 *   - **Retry with exponential backoff.** Default 3 attempts at
 *     1s, 4s, 16s. Configurable. After exhausting retries, the
 *     event is dropped and an `error`-level log entry is emitted
 *     with the event id and the last response status / message.
 *
 *   - **Event filtering.** Operators subscribe to specific event
 *     types via `events: [...]`. Default is "all events".
 *
 *   - **No persistence.** Pending webhooks live in an in-memory
 *     queue. A process restart loses pending events. Operators who
 *     need durability mirror this module against their own
 *     persistent queue (Postgres, SQS, Redis Streams).
 *
 * @example
 * ```ts
 * createPaidMcpServer({
 *     // ...
 *     webhooks: {
 *         url: 'https://example.com/mppmcp/webhook',
 *         secret: process.env.WEBHOOK_SECRET!,
 *         events: ['payment.received', 'session.closed'],
 *     },
 * })
 * ```
 *
 * @example receiver verification (Node)
 * ```ts
 * import { createHmac } from 'node:crypto'
 *
 * function verify(req: { headers: Record<string, string>, body: string }) {
 *     const expected = 'sha256=' + createHmac('sha256', process.env.WEBHOOK_SECRET!)
 *         .update(`${req.headers['x-mppmcp-timestamp']}.${req.body}`)
 *         .digest('hex')
 *     // Compare via timingSafeEqual in real code.
 *     return expected === req.headers['x-mppmcp-signature']
 * }
 * ```
 *
 * @module
 */

import type { Logger } from './logger.js'
import { hmacSha256Hex, randomHex } from './runtime.js'

// -------------------------------------------------------------------
// Event types
// -------------------------------------------------------------------

/** Event type tags. Stable strings — adding a tag is a minor bump. */
export type WebhookEventType =
    | 'payment.received'
    | 'access-key.issued'
    | 'access-key.expired'
    | 'session.opened'
    | 'session.closed'
    | 'call.failed'

/**
 * The full webhook event envelope sent in the POST body. The `data`
 * field's shape varies by `type`; the rest is invariant.
 */
export type WebhookEvent =
    | { id: string; type: 'payment.received'; createdAt: string; data: PaymentReceivedData }
    | { id: string; type: 'access-key.issued'; createdAt: string; data: AccessKeyIssuedData }
    | { id: string; type: 'access-key.expired'; createdAt: string; data: AccessKeyExpiredData }
    | { id: string; type: 'session.opened'; createdAt: string; data: SessionOpenedData }
    | { id: string; type: 'session.closed'; createdAt: string; data: SessionClosedData }
    | { id: string; type: 'call.failed'; createdAt: string; data: CallFailedData }

export interface PaymentReceivedData {
    /** Tool that was called. */
    tool: string
    /** Payment mode the call resolved to. */
    mode: 'per-call' | 'tiered' | 'session' | 'access-key'
    /** Amount in USD as a decimal string. */
    amount: string
    /** On-chain tx hash, when settlement produced one. */
    txHash?: string
}

export interface AccessKeyIssuedData {
    /** Tool the key authorizes. */
    tool: string
    /** Key token (the same opaque string the agent will present). */
    key: string
    /** ISO 8601 expiry, when `validFor` was set. */
    expiresAt?: string
    /** Initial call budget, when `maxCalls` was set. */
    remainingCalls?: number
    /** Tx hash of the upfront payment. */
    txHash?: string
}

export interface AccessKeyExpiredData {
    /** Tool the key authorized. */
    tool: string
    /** The token that just expired. */
    key: string
    /** Why the key was rejected. */
    reason: 'expired' | 'exhausted'
}

export interface SessionOpenedData {
    /** Tool that opened the channel. */
    tool: string
    /** Total open channel count after this open (server-wide). */
    sessionsOpen: number
}

export interface SessionClosedData {
    /** Tool whose channel closed. */
    tool: string
    /** Final cumulative voucher amount, in USD. */
    amount: string
    /** On-chain settlement tx hash. */
    txHash?: string
    /** Total open channel count after this close (server-wide). */
    sessionsOpen: number
}

export interface CallFailedData {
    /** Tool that was called. */
    tool: string
    /** Stable error code, when the failure was a typed `MppMcpError`. */
    code?: string
    /** Human-readable error message. */
    message: string
}

// -------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------

export interface WebhookConfig {
    /**
     * Endpoint that receives event POSTs. Must accept JSON bodies
     * and return a 2xx status to acknowledge delivery; non-2xx
     * triggers retry.
     */
    url: string

    /**
     * Shared secret used to sign the `X-MppMcp-Signature` header.
     * Treat as a credential — anyone with this value can forge
     * events. Recommend a 32+ char random string.
     */
    secret: string

    /**
     * Event types to subscribe to. Omit to receive every event.
     */
    events?: WebhookEventType[]

    /**
     * Maximum number of delivery attempts per event before drop.
     * @default 3
     */
    maxAttempts?: number

    /**
     * Base delay between retry attempts in milliseconds. The actual
     * delay grows by 4x per attempt (1s → 4s → 16s by default).
     * @default 1000
     */
    initialBackoffMs?: number

    /**
     * Per-attempt request timeout in milliseconds. A receiver that
     * hangs without responding is treated as failed and retried.
     * @default 5000
     */
    timeoutMs?: number

    /**
     * Optional fetch override for tests and edge runtimes that
     * supply a non-global fetch. Defaults to `globalThis.fetch`.
     */
    fetch?: typeof globalThis.fetch
}

// -------------------------------------------------------------------
// Dispatcher
// -------------------------------------------------------------------

/**
 * Internal dispatcher that owns event delivery. The server holds
 * one of these per configured webhook and calls `emit()` from event
 * sites (payment receipt, access-key issuance, etc.).
 */
export class WebhookDispatcher {
    private readonly url: string
    private readonly secret: string
    private readonly events: Set<WebhookEventType> | null
    private readonly maxAttempts: number
    private readonly initialBackoffMs: number
    private readonly timeoutMs: number
    private readonly fetchImpl: typeof globalThis.fetch
    private readonly logger: Logger

    /**
     * Tracks in-flight deliveries so the server's graceful
     * shutdown can wait for them before returning. Each promise
     * resolves on success or final failure (after retries).
     */
    private readonly inFlight = new Set<Promise<void>>()

    constructor(config: WebhookConfig, logger: Logger) {
        if (!config.url || typeof config.url !== 'string') {
            throw new Error('webhooks: url must be a non-empty string')
        }
        if (!config.secret || typeof config.secret !== 'string') {
            throw new Error('webhooks: secret must be a non-empty string')
        }
        this.url = config.url
        this.secret = config.secret
        this.events = config.events ? new Set(config.events) : null
        this.maxAttempts = Math.max(1, config.maxAttempts ?? 3)
        this.initialBackoffMs = Math.max(0, config.initialBackoffMs ?? 1000)
        this.timeoutMs = Math.max(100, config.timeoutMs ?? 5000)
        this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis)
        this.logger = logger.child({ component: 'webhooks' })
    }

    /**
     * Emit an event. Fire-and-forget: the call returns immediately
     * after enqueueing. Delivery happens in the background; the
     * caller's tool-call latency is not affected.
     *
     * Subscribers that filter by event type drop unsubscribed events
     * silently — no work is queued.
     */
    emit<T extends WebhookEventType>(
        type: T,
        data: Extract<WebhookEvent, { type: T }>['data']
    ): void {
        if (this.events && !this.events.has(type)) return

        const event = {
            id: `evt_${randomHex(12)}`,
            type,
            createdAt: new Date().toISOString(),
            data,
        } as WebhookEvent

        // Fire the delivery promise. We track it via inFlight so
        // graceful shutdown can drain pending dispatches. The
        // promise resolves on success OR final failure — no
        // unhandled rejections.
        const promise = this.deliver(event).finally(() => {
            this.inFlight.delete(promise)
        })
        this.inFlight.add(promise)
    }

    /**
     * Wait for all currently-in-flight deliveries to settle.
     * Resolves once every queued event has either been
     * acknowledged or exhausted its retry budget. Used by
     * `PaidMcpServer.close()` so shutdown drains pending
     * webhooks within the configured window.
     */
    async drain(): Promise<void> {
        // Snapshot the set: new emits during drain shouldn't
        // extend the wait indefinitely. The shutdown path
        // already gates new emits via the server's
        // `shuttingDown` flag.
        const pending = Array.from(this.inFlight)
        await Promise.allSettled(pending)
    }

    /** @internal Number of currently-pending deliveries. */
    inFlightCount(): number {
        return this.inFlight.size
    }

    /**
     * @internal Deliver one event. Retries on non-2xx and on
     * transport errors. Eats the final failure into a logger
     * warning so we never produce unhandled rejections.
     */
    private async deliver(event: WebhookEvent): Promise<void> {
        const body = JSON.stringify(event)
        const timestamp = Math.floor(Date.now() / 1000)
        const signature = await this.sign(timestamp, body)

        let lastError: { status?: number; message: string } | null = null
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            try {
                const ctrl = new AbortController()
                const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
                let response: Response
                try {
                    response = await this.fetchImpl(this.url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-MppMcp-Timestamp': String(timestamp),
                            'X-MppMcp-Signature': `sha256=${signature}`,
                            'X-MppMcp-Event': event.type,
                        },
                        body,
                        signal: ctrl.signal,
                    })
                } finally {
                    clearTimeout(timer)
                }
                if (response.ok) {
                    if (attempt > 1) {
                        this.logger.info('webhook delivered after retries', {
                            eventId: event.id,
                            type: event.type,
                            attempts: attempt,
                        })
                    }
                    return
                }
                lastError = {
                    status: response.status,
                    message: `HTTP ${response.status}`,
                }
            } catch (err) {
                lastError = {
                    message: err instanceof Error ? err.message : String(err),
                }
            }

            // If we have another attempt left, back off.
            if (attempt < this.maxAttempts) {
                const delay = this.initialBackoffMs * Math.pow(4, attempt - 1)
                await sleep(delay)
            }
        }

        // All attempts failed. Log and drop.
        this.logger.error('webhook delivery failed', {
            eventId: event.id,
            type: event.type,
            url: this.url,
            attempts: this.maxAttempts,
            ...(lastError ?? {}),
        })
    }

    /**
     * @internal Compute the X-MppMcp-Signature value over
     * `${timestamp}.${body}`. Matches the receiver-side
     * verification snippet in the module docstring.
     */
    private async sign(timestamp: number, body: string): Promise<string> {
        return hmacSha256Hex(this.secret, `${timestamp}.${body}`)
    }
}

/**
 * Build a {@link WebhookDispatcher}. Convenience wrapper exposed
 * for advanced users who want to drive event emission from custom
 * code paths; the typical case is to set `webhooks` on
 * {@link PaidMcpServerConfig} and let the gateway handle it.
 */
export function createWebhookDispatcher(
    config: WebhookConfig,
    logger: Logger
): WebhookDispatcher {
    return new WebhookDispatcher(config, logger)
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
