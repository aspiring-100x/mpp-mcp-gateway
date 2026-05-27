/**
 * mpp-mcp-gateway — server
 *
 * Build MCP servers whose tools charge stablecoin micropayments via MPP
 * on Tempo. Each tool call triggers an MPP 402-style challenge; after the
 * agent pays, the tool handler runs and the response includes a receipt.
 *
 * Two pricing primitives are supported:
 *
 * - **per-call / tiered** — each call routes through `tempo.charge`, which
 *   issues a one-shot transferWithMemo on Tempo. Sub-second settlement, but
 *   one on-chain tx per call.
 *
 * - **session** — first call routes through `tempo.session`, which opens an
 *   on-chain escrow channel. Subsequent calls accept signed cumulative
 *   vouchers off-chain; the server settles the highest voucher when the
 *   client closes the channel. Best for streaming or high-frequency use.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Mppx, tempo, Transport } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'
import type { z } from 'zod'

import {
    issueRecord,
    redeem,
    storeRecord,
    toClientView,
    validateAccessKeyPricing,
    type AccessKeyRecord,
} from './access-keys.js'
import {
    REVENUE_DECIMALS,
    baseUnitsToUsdString,
    usdStringToBaseUnits,
} from './amounts.js'
import {
    ACCESS_KEY_META,
    DEFAULT_CURRENCY,
    TEMPO_ESCROW_MAINNET,
    TEMPO_ESCROW_TESTNET,
    TEMPO_MAINNET,
    TEMPO_TESTNET,
} from './constants.js'
import { ConfigurationError, InternalError, RateLimitExceededError, ShutdownTimeoutError, ShuttingDownError } from './errors.js'
import { defaultLogger, type Logger } from './logger.js'
import {
    noopLimiter,
    tokenBucketLimiter,
    type RateLimiter,
} from './rate-limit.js'
import {
    bridgeMppxStore,
    createMemoryStore,
    isMppMcpStore,
    type MppMcpStore,
} from './stores/index.js'
import {
    startSpan,
    TRACE_ATTRS,
    TRACE_SPANS,
    type ActiveSpan,
} from './tracing.js'
import { WebhookDispatcher } from './webhooks.js'
import type {
    CallLogEntry,
    GatewayStats,
    PaidMcpServerConfig,
    PaidToolDefinition,
    PricingModel,
    ToolHandlerResult,
} from './types.js'
import type { Tracer } from '@opentelemetry/api'

/** Compute the current price for a tool based on its pricing model and call count. */
function priceFor(pricing: PricingModel | undefined, calls: number): string | null {
    if (!pricing) return null // free tool
    if (pricing.type === 'per-call') return pricing.amount
    if (pricing.type === 'session') return pricing.amount
    if (pricing.type === 'access-key') return pricing.amount

    // tiered pricing
    for (const tier of pricing.tiers) {
        if (tier.upTo === 'unlimited' || calls < tier.upTo) return tier.amount
    }
    return pricing.tiers[pricing.tiers.length - 1]!.amount
}

/** Whether any tool on this server uses session pricing. */
function hasSessionPricing(tools: PaidToolDefinition[]): boolean {
    return tools.some((t) => t.pricing?.type === 'session')
}

/**
 * A payment-gated MCP server. Holds the MPP payment handler, the MCP server,
 * and the stats tracker.
 */
export class PaidMcpServer {
    private config: Required<
        Pick<PaidMcpServerConfig, 'currency' | 'network' | 'recipient' | 'secretKey'>
    > &
        PaidMcpServerConfig
    private mppx: ReturnType<typeof createMppxPayment>
    private mcp: McpServer
    private tools: Map<string, PaidToolDefinition>
    private stats: GatewayStats
    /**
     * Internal revenue ledger in base units (BigInt). The string fields
     * `stats.totalRevenue` and `stats.revenueByTool[tool]` are projected
     * from these on every `getStats()` call. Doing arithmetic in BigInt
     * keeps revenue exact across millions of additions; floats would
     * accumulate drift after a few thousand sub-cent calls.
     */
    private totalRevenueUnits: bigint
    private revenueUnitsByTool: Map<string, bigint>
    private startTime: number
    private accessKeyStore: MppMcpStore
    /** Structured logger for runtime events. Never null after construction. */
    private logger: Logger
    /**
     * In-flight tool calls — incremented when a call enters the
     * wrapping handler, decremented when it leaves (success or error).
     * Drives the drain logic in {@link PaidMcpServer.close}.
     */
    private inFlight: number
    /**
     * Set to `true` once {@link PaidMcpServer.close} begins. New tool
     * calls observed after this point are rejected with
     * {@link ShuttingDownError}; in-flight calls run to completion.
     */
    private shuttingDown: boolean
    /**
     * Cached close promise so calling `close()` twice doesn't kick off
     * two parallel shutdowns. Idempotent semantics.
     */
    private closePromise: Promise<void> | null
    /** Default drain timeout in ms; overridable per-call via close({ timeoutMs }). */
    private defaultDrainTimeoutMs: number
    /** Optional shutdown hook fired once when drain begins. */
    private onShutdown: (() => void | Promise<void>) | undefined
    /** Rate limiter used to throttle 402 issuance. Always set after construction. */
    private rateLimiter: RateLimiter
    /**
     * Function to derive the bucket key from `(toolName, extra)`.
     * Default keys by tool name. Operators on HTTP/SSE transports
     * typically swap this for a session-id-aware extractor.
     */
    private rateLimitKeyExtractor: (
        toolName: string,
        extra: Record<string, unknown>
    ) => string
    /**
     * Optional OpenTelemetry tracer. `undefined` when tracing is
     * not configured — every tracing helper short-circuits in that
     * case so non-traced deployments pay zero cost.
     */
    private tracer: Tracer | undefined
    /**
     * Optional webhook dispatcher. `undefined` when no
     * `webhooks` config was supplied. When set, runtime event
     * sites (paid call settled, access-key issued, session opened
     * / closed, call failed) emit through it asynchronously.
     */
    private webhooks: WebhookDispatcher | undefined
    /**
     * Fixed-size ring buffer of recent calls. Pre-allocated to
     * `callLogCapacity` and reused — `appendCall` is O(1) regardless of
     * fill state, which matters under sustained high-throughput load
     * where the previous splice-based implementation became a bottleneck.
     *
     * Slots beyond the current count hold `undefined` until they're
     * written. `callLogCount` tracks how many slots have been populated
     * (saturates at capacity). `callLogWriteIndex` points to the next
     * slot to write, wrapping modulo capacity.
     */
    private callLog: Array<CallLogEntry | undefined>
    private callLogCapacity: number
    private callLogCount: number
    private callLogWriteIndex: number

    constructor(config: PaidMcpServerConfig) {
        this.config = {
            ...config,
            currency: config.currency ?? DEFAULT_CURRENCY,
            network: config.network ?? 'testnet',
        }

        // Resolve the logger first so subsequent setup steps (store
        // bridging, validation warnings) can route through it.
        this.logger = (config.logger ?? defaultLogger()).child({
            component: 'paid-mcp-server',
            server: config.name,
        })

        // Validate access-key pricing up-front so misconfiguration fails fast.
        for (const tool of config.tools) {
            if (tool.pricing?.type === 'access-key') {
                validateAccessKeyPricing(tool.name, tool.pricing)
            }
        }

        // Resolve the access-key store. Three cases:
        //   1. User passed a four-method MppMcpStore → use directly.
        //   2. User passed a legacy three-method store → bridge it
        //      (best-effort `update`, with a one-shot warning routed
        //      through the configured logger).
        //   3. Nothing passed → in-memory default with atomic update.
        this.accessKeyStore = resolveStore(config.accessKeyStore, this.logger)

        this.callLogCapacity = Math.max(0, config.callLogSize ?? 1000)
        // Pre-allocate the ring buffer so `appendCall` never has to grow
        // the array. When capacity is 0 we keep an empty array — the
        // append path short-circuits before writing.
        this.callLog =
            this.callLogCapacity === 0
                ? []
                : new Array<CallLogEntry | undefined>(this.callLogCapacity).fill(undefined)
        this.callLogCount = 0
        this.callLogWriteIndex = 0

        // Build mppx payment handler with Tempo charge + session methods and
        // the MCP SDK transport. This makes each paid call issue a
        // McpError(-32042) on first invocation and attach a receipt via _meta
        // on the retry.
        this.mppx = createMppxPayment(this.config, this.logger)

        // Create the underlying MCP server
        this.mcp = new McpServer({
            name: config.name,
            version: config.version,
        })

        this.tools = new Map()
        for (const tool of config.tools) {
            this.tools.set(tool.name, tool)
            this.registerTool(tool)
        }

        this.startTime = Date.now()
        this.totalRevenueUnits = 0n
        this.revenueUnitsByTool = new Map()
        this.stats = {
            totalCalls: 0,
            paidCalls: 0,
            freeCalls: 0,
            sessionCalls: 0,
            accessKeyCalls: 0,
            totalRevenue: '0',
            callsByTool: {},
            revenueByTool: {},
            sessionsOpened: 0,
            sessionsClosed: 0,
            accessKeysIssued: 0,
            accessKeysExpired: 0,
            uptimeMs: 0,
            startedAt: new Date().toISOString(),
        }

        this.inFlight = 0
        this.shuttingDown = false
        this.closePromise = null
        this.defaultDrainTimeoutMs = config.drainTimeoutMs ?? 30_000
        this.onShutdown = config.onShutdown

        // Resolve the rate limiter. Three cases mirror the store
        // resolution: explicit limiter wins, then constructor-built
        // token bucket, then noop when disabled.
        const rl = config.rateLimit ?? {}
        if (rl.enabled === false) {
            this.rateLimiter = noopLimiter()
        } else if (rl.limiter) {
            this.rateLimiter = rl.limiter
        } else {
            this.rateLimiter = tokenBucketLimiter({
                refillPerMinute: rl.refillPerMinute,
                capacity: rl.capacity,
            })
        }
        this.rateLimitKeyExtractor =
            rl.keyExtractor ?? ((toolName) => toolName)
        this.tracer = config.tracer
        // Webhook dispatcher only exists when explicitly configured.
        // The constructor validates url/secret eagerly so a missing
        // value crashes startup rather than silently dropping
        // events later.
        this.webhooks = config.webhooks
            ? new WebhookDispatcher(config.webhooks, this.logger)
            : undefined
    }

    /**
     * Register a tool with the MCP server, wrapping its handler in an MPP
     * charge or session flow (unless it's free).
     */
    private registerTool(tool: PaidToolDefinition): void {
        const { currency, recipient } = this.config

        const handler = async (
            args: Record<string, unknown>,
            extra: Record<string, unknown> & {
                _meta?: Record<string, unknown>
            }
        ) => {
            // Shutdown gate: refuse new work after `close()` has begun.
            // This runs before any pricing or payment logic so a closing
            // gateway never issues a 402 it can't fulfill.
            if (this.shuttingDown) {
                throw new ShuttingDownError({ tool: tool.name })
            }

            // Rate-limit gate: cap the rate at which we'll issue 402
            // challenges or run handlers for this tool. Fires before
            // the in-flight increment so denied calls never count
            // against the drain budget. Limiter denials carry a
            // suggested retry-after so well-behaved clients can back
            // off without spinning into deeper throttling.
            const bucketKey = this.rateLimitKeyExtractor(tool.name, extra)
            const verdict = await this.rateLimiter.consume(bucketKey)
            if (!verdict.allowed) {
                this.logger.warn('rate limit exceeded', {
                    tool: tool.name,
                    bucketKey,
                    retryAfterMs: verdict.retryAfterMs,
                })
                throw new RateLimitExceededError({
                    tool: tool.name,
                    bucketKey,
                    retryAfterMs: verdict.retryAfterMs,
                })
            }

            // In-flight tracking. Increment before any awaits so the
            // counter accurately reflects every observable execution
            // unit. The `try/finally` guarantees decrement on every
            // return path (success, thrown error, 402 challenge).
            this.inFlight++
            // Root span for this tool call. Lives across rate-limit,
            // payment, handler, and result phases. Attributes are
            // populated as the call progresses; status is set in
            // the finally block based on whether the handler threw.
            const rootSpan = startSpan(this.tracer, TRACE_SPANS.TOOL_CALL, {
                [TRACE_ATTRS.TOOL_NAME]: tool.name,
                [TRACE_ATTRS.PRICING_TYPE]: tool.pricing?.type ?? 'free',
            })
            try {
                const result = await this.runWrappedHandler(
                    tool,
                    args,
                    extra,
                    currency,
                    recipient,
                    rootSpan
                )
                rootSpan.setOk()
                return result
            } catch (err) {
                // 402 challenges aren't real failures — they're
                // control flow signaling "agent should pay and
                // retry". Mark the span OK with a hint attribute
                // rather than ERROR so traces don't look alarming
                // in dashboards.
                if (isPaymentRequired(err)) {
                    rootSpan.setAttribute('mppmcp.outcome', 'payment-required')
                    rootSpan.setOk()
                } else {
                    rootSpan.setError(err)
                }
                throw err
            } finally {
                rootSpan.end()
                this.inFlight--
            }
        }

        this.mcp.registerTool(
            tool.name,
            {
                description: tool.description,
                inputSchema: tool.inputSchema,
            },
            handler as never
        )
    }

    /**
     * @internal The original wrapping-handler body, extracted so the
     * registerTool path can compose shutdown gating + in-flight
     * tracking around it without losing readability.
     */
    private async runWrappedHandler(
        tool: PaidToolDefinition,
        args: Record<string, unknown>,
        extra: Record<string, unknown> & {
            _meta?: Record<string, unknown>
        },
        currency: `0x${string}`,
        recipient: `0x${string}`,
        rootSpan: ActiveSpan
    ): Promise<unknown> {
        const start = Date.now()
        const currentCalls = this.stats.callsByTool[tool.name] ?? 0

        try {
            // Free tool — no payment flow.
            if (!tool.pricing) {
                this.stats.totalCalls++
                this.stats.freeCalls++
                this.stats.callsByTool[tool.name] = currentCalls + 1
                rootSpan.setAttribute(TRACE_ATTRS.PAYMENT_MODE, 'free')
                const result = await this.runUserHandler(tool, args)
                this.appendCall({
                    tool: tool.name,
                    timestamp: new Date().toISOString(),
                    durationMs: Date.now() - start,
                    paid: false,
                    paymentMode: 'free',
                })
                return toMcpResult(result)
            }

            // Access-key path: try to redeem first, fall through to payment.
            if (tool.pricing.type === 'access-key') {
                return await this.runAccessKey(tool, args, extra, start, rootSpan)
            }

            // Paid path — choose the right intent.
            if (tool.pricing.type === 'session') {
                return await this.runSession(tool, args, extra, start, rootSpan)
            }

            // per-call / tiered → charge intent
            const amount = priceFor(tool.pricing, currentCalls)!
            rootSpan.setAttribute(TRACE_ATTRS.AMOUNT, amount)
            rootSpan.setAttribute(TRACE_ATTRS.PAYMENT_MODE, tool.pricing.type)

            // Wrap mppx.charge in a child span so the on-chain
            // settle latency shows up distinctly from handler time.
            const chargeSpan = startSpan(this.tracer, TRACE_SPANS.PAYMENT_CHARGE, {
                [TRACE_ATTRS.TOOL_NAME]: tool.name,
                [TRACE_ATTRS.AMOUNT]: amount,
            })
            let outcome: Awaited<ReturnType<ReturnType<typeof this.mppx.charge>>>
            try {
                const charge = this.mppx.charge({
                    amount,
                    currency,
                    recipient,
                    description: tool.description,
                })
                outcome = await charge(extra)
                if (outcome.status === 402) {
                    chargeSpan.setAttribute('mppmcp.outcome', 'payment-required')
                    chargeSpan.setOk()
                    throw outcome.challenge
                }
                chargeSpan.setOk()
            } catch (err) {
                if (!isPaymentRequired(err)) chargeSpan.setError(err)
                throw err
            } finally {
                chargeSpan.end()
            }

            const result = await this.runUserHandler(tool, args)
            this.recordPaidCall(tool.name, amount)
            this.appendCall({
                tool: tool.name,
                timestamp: new Date().toISOString(),
                durationMs: Date.now() - start,
                paid: true,
                paymentMode: tool.pricing.type, // 'per-call' | 'tiered'
                amount,
            })
            // Attach the tx hash to the root span if the receipt
            // surfaced one. mppx wraps the return; we sniff at the
            // structuredContent / _meta level after the wrap.
            const wrapped = outcome.withReceipt(toMcpResult(result))
            const receipt = readReceipt(wrapped)
            if (receipt?.reference) {
                rootSpan.setAttribute(TRACE_ATTRS.PAYMENT_TX_HASH, receipt.reference)
            }
            this.webhooks?.emit('payment.received', {
                tool: tool.name,
                mode: tool.pricing.type,
                amount,
                ...(receipt?.reference && { txHash: receipt.reference }),
            })
            return wrapped
        } catch (err) {
            // 402 challenges flow through the catch but they aren't real
            // failures — they're control-flow signals to the client. We
            // detect them by the presence of `data.challenges` and skip
            // logging them as errors.
            if (!isPaymentRequired(err)) {
                const message =
                    err instanceof Error
                        ? err.message
                        : String(err ?? 'unknown error')
                this.appendCall({
                    tool: tool.name,
                    timestamp: new Date().toISOString(),
                    durationMs: Date.now() - start,
                    paid: false,
                    paymentMode: tool.pricing
                        ? tool.pricing.type === 'access-key'
                            ? 'access-key'
                            : tool.pricing.type === 'session'
                                ? 'session'
                                : tool.pricing.type === 'tiered'
                                    ? 'tiered'
                                    : 'per-call'
                        : 'free',
                    error: message,
                })
                // Emit call.failed for genuine failures only —
                // payment-required (402) is control flow.
                const code = readErrorCode(err)
                this.webhooks?.emit('call.failed', {
                    tool: tool.name,
                    ...(code && { code }),
                    message,
                })
            }
            throw err
        }
    }

    /**
     * @internal Run the user's handler inside a `mppmcp.handler.run`
     * child span. Centralized so every pricing path produces the
     * same span name — operators can filter dashboards by it without
     * caring about which path the call took.
     */
    private async runUserHandler(
        tool: PaidToolDefinition,
        args: Record<string, unknown>
    ): Promise<ToolHandlerResult> {
        const span = startSpan(this.tracer, TRACE_SPANS.HANDLER_RUN, {
            [TRACE_ATTRS.TOOL_NAME]: tool.name,
        })
        try {
            const result = await tool.handler(args)
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
     * Run a session-priced tool. The first call opens an on-chain escrow
     * channel (the client signs the open tx); subsequent calls supply
     * incremental signed vouchers that the server validates and stores.
     *
     * The mppx.session() handler does all the heavy lifting (challenge
     * issuance, voucher validation, channel-state mutation, settlement).
     * Our job is to feed it the right config and update our own stats.
     */
    private async runSession(
        tool: PaidToolDefinition,
        args: Record<string, unknown>,
        extra: Record<string, unknown> & {
            _meta?: Record<string, unknown>
        },
        start: number,
        rootSpan: ActiveSpan
    ): Promise<unknown> {
        if (tool.pricing?.type !== 'session') {
            throw new InternalError(
                `runSession called on tool with non-session pricing: ${tool.name}`
            )
        }
        const sessionFn = (this.mppx as unknown as {
            session?: (opts: unknown) => (extra: unknown) => Promise<{
                status: 200
                withReceipt: (result: unknown) => unknown
            } | { status: 402; challenge: unknown }>
        }).session
        if (!sessionFn) {
            throw new ConfigurationError(
                `Session pricing requires escrowContract / store wiring. ` +
                `If you intentionally use session pricing, ensure the server ` +
                `was constructed with at least one session-priced tool so ` +
                `mppx is configured correctly.`
            )
        }

        rootSpan.setAttribute(TRACE_ATTRS.PAYMENT_MODE, 'session')
        rootSpan.setAttribute(TRACE_ATTRS.AMOUNT, tool.pricing.amount)

        // Wrap the channel-advance step in a child span. This phase
        // covers challenge issuance, voucher validation, and channel
        // mutation — when latency spikes, this is usually where.
        const advanceSpan = startSpan(this.tracer, TRACE_SPANS.SESSION_ADVANCE, {
            [TRACE_ATTRS.TOOL_NAME]: tool.name,
            [TRACE_ATTRS.AMOUNT]: tool.pricing.amount,
        })

        const session = sessionFn({
            amount: tool.pricing.amount,
            unitType: tool.pricing.unitType,
            currency: this.config.currency,
            recipient: this.config.recipient,
            description: tool.description,
            ...(tool.pricing.suggestedDeposit !== undefined && {
                suggestedDeposit: tool.pricing.suggestedDeposit,
            }),
        })

        let outcome: Awaited<ReturnType<ReturnType<typeof sessionFn>>>
        try {
            outcome = await session(extra)
            if (outcome.status === 402) {
                advanceSpan.setAttribute('mppmcp.outcome', 'payment-required')
                advanceSpan.setOk()
                throw outcome.challenge
            }
            advanceSpan.setOk()
        } catch (err) {
            if (!isPaymentRequired(err)) advanceSpan.setError(err)
            throw err
        } finally {
            advanceSpan.end()
        }

        const result = await this.runUserHandler(tool, args)

        // Inspect the inbound credential to understand what just happened on
        // the channel — open / topUp / voucher / close — and update stats.
        // The mcp-sdk server transport places the already-deserialized
        // Credential object at extra._meta[credentialMetaKey], so we read
        // it directly rather than re-deserializing.
        let action: string | undefined
        try {
            const cred = (extra._meta as Record<string, unknown> | undefined)?.[
                'org.paymentauth/credential'
            ] as { payload?: { action?: string } } | undefined
            action = cred?.payload?.action
            if (action === 'open') this.stats.sessionsOpened++
            if (action === 'close') this.stats.sessionsClosed++
        } catch {
            // Stats are best-effort. A malformed credential would have been
            // rejected by mppx.session() before we got here.
        }
        if (action) rootSpan.setAttribute(TRACE_ATTRS.SESSION_ACTION, action)

        this.recordPaidCall(tool.name, tool.pricing.amount, true)
        this.appendCall({
            tool: tool.name,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - start,
            paid: true,
            paymentMode: 'session',
            amount: tool.pricing.amount,
        })
        const wrapped = outcome.withReceipt(toMcpResult(result))
        const receipt = readReceipt(wrapped)
        if (receipt?.reference) {
            rootSpan.setAttribute(TRACE_ATTRS.PAYMENT_TX_HASH, receipt.reference)
        }
        // Compute the live "open channels" count (opened minus
        // closed) for inclusion in the webhook payload. This gives
        // operators a running counter without needing to subscribe
        // to every event and do their own arithmetic.
        const sessionsOpen =
            this.stats.sessionsOpened - this.stats.sessionsClosed
        if (action === 'open') {
            this.webhooks?.emit('session.opened', {
                tool: tool.name,
                sessionsOpen,
            })
        }
        if (action === 'close') {
            this.webhooks?.emit('session.closed', {
                tool: tool.name,
                amount: tool.pricing.amount,
                ...(receipt?.reference && { txHash: receipt.reference }),
                sessionsOpen,
            })
        }
        // Emit a generic payment.received for every voucher /
        // open / close — operators tracking revenue dashboards
        // typically want the per-call amount regardless of the
        // session sub-action.
        this.webhooks?.emit('payment.received', {
            tool: tool.name,
            mode: 'session',
            amount: tool.pricing.amount,
            ...(receipt?.reference && { txHash: receipt.reference }),
        })
        return wrapped
    }

    /**
     * Run an access-key-priced tool. Two flows:
     *
     *   1. Cached key path — request `_meta` carries an access-key token. We
     *      look it up, validate it (tool match, not expired, not exhausted),
     *      decrement the counter, and run the handler free. Result includes
     *      the (possibly-decremented) key state.
     *
     *   2. Pay-and-issue path — no key (or key was rejected). We treat this
     *      like a normal one-shot `tempo.charge` for the upfront amount.
     *      After the on-chain settle resolves, we mint a new access-key
     *      record, attach it to the result, and return.
     */
    private async runAccessKey(
        tool: PaidToolDefinition,
        args: Record<string, unknown>,
        extra: Record<string, unknown> & {
            _meta?: Record<string, unknown>
        },
        start: number,
        rootSpan: ActiveSpan
    ): Promise<unknown> {
        if (tool.pricing?.type !== 'access-key') {
            throw new InternalError(
                `runAccessKey called on tool with non-access-key pricing: ${tool.name}`
            )
        }
        const pricing = tool.pricing
        const incomingKey = (extra._meta as Record<string, unknown> | undefined)?.[
            ACCESS_KEY_META
        ]

        if (typeof incomingKey === 'string' && incomingKey.length > 0) {
            // Redeem in a child span so dashboards can isolate cache-hit
            // latency (typically sub-ms) from the pay-and-issue path.
            const redeemSpan = startSpan(
                this.tracer,
                TRACE_SPANS.ACCESS_KEY_REDEEM,
                { [TRACE_ATTRS.TOOL_NAME]: tool.name }
            )
            let outcome: Awaited<ReturnType<typeof redeem>>
            try {
                outcome = await redeem(this.accessKeyStore, incomingKey, tool.name)
                redeemSpan.setAttribute(
                    'mppmcp.access-key.outcome',
                    outcome.ok ? 'ok' : outcome.reason
                )
                redeemSpan.setOk()
            } catch (err) {
                redeemSpan.setError(err)
                throw err
            } finally {
                redeemSpan.end()
            }
            if (outcome.ok) {
                // Free call against a valid key.
                rootSpan.setAttribute(TRACE_ATTRS.PAYMENT_MODE, 'access-key-cached')
                const result = await this.runUserHandler(tool, args)
                this.stats.totalCalls++
                this.stats.accessKeyCalls++
                const calls = this.stats.callsByTool[tool.name] ?? 0
                this.stats.callsByTool[tool.name] = calls + 1
                this.appendCall({
                    tool: tool.name,
                    timestamp: new Date().toISOString(),
                    durationMs: Date.now() - start,
                    paid: false,
                    paymentMode: 'access-key-cached',
                })
                return attachAccessKey(toMcpResult(result), outcome.record, false)
            }
            // Key was rejected. If it expired or was exhausted, count it.
            if (outcome.reason === 'expired' || outcome.reason === 'exhausted') {
                this.stats.accessKeysExpired++
                this.webhooks?.emit('access-key.expired', {
                    tool: tool.name,
                    key: incomingKey,
                    reason: outcome.reason,
                })
            }
            // Fall through to the pay flow — agent will need to pay again.
        }

        // No key (or rejected). Charge the upfront fee.
        rootSpan.setAttribute(TRACE_ATTRS.PAYMENT_MODE, 'access-key')
        rootSpan.setAttribute(TRACE_ATTRS.AMOUNT, pricing.amount)

        const chargeSpan = startSpan(this.tracer, TRACE_SPANS.PAYMENT_CHARGE, {
            [TRACE_ATTRS.TOOL_NAME]: tool.name,
            [TRACE_ATTRS.AMOUNT]: pricing.amount,
        })
        let outcome: Awaited<ReturnType<ReturnType<typeof this.mppx.charge>>>
        try {
            const charge = this.mppx.charge({
                amount: pricing.amount,
                currency: this.config.currency,
                recipient: this.config.recipient,
                description: `${tool.description} (issues access key)`,
            })
            outcome = await charge(extra)
            if (outcome.status === 402) {
                chargeSpan.setAttribute('mppmcp.outcome', 'payment-required')
                chargeSpan.setOk()
                throw outcome.challenge
            }
            chargeSpan.setOk()
        } catch (err) {
            if (!isPaymentRequired(err)) chargeSpan.setError(err)
            throw err
        } finally {
            chargeSpan.end()
        }

        // Payment cleared. Run the handler, then issue a new key.
        const result = await this.runUserHandler(tool, args)
        const record = issueRecord({
            toolName: tool.name,
            pricing,
        })
        await storeRecord(this.accessKeyStore, record)
        this.stats.accessKeysIssued++
        rootSpan.setAttribute(TRACE_ATTRS.ACCESS_KEY_JUST_ISSUED, true)

        // The first redeem of a key happens implicitly by the call that paid
        // for it — decrement once if maxCalls was set.
        const decremented: AccessKeyRecord =
            record.remainingCalls !== null
                ? { ...record, remainingCalls: record.remainingCalls - 1 }
                : record
        if (decremented.remainingCalls !== null) {
            await storeRecord(this.accessKeyStore, decremented)
        }

        this.recordPaidCall(tool.name, pricing.amount)
        const withReceipt = outcome.withReceipt(toMcpResult(result)) as Record<
            string,
            unknown
        >
        const receipt = readReceipt(withReceipt)
        if (receipt?.reference) {
            rootSpan.setAttribute(TRACE_ATTRS.PAYMENT_TX_HASH, receipt.reference)
        }
        this.appendCall({
            tool: tool.name,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - start,
            paid: true,
            paymentMode: 'access-key',
            amount: pricing.amount,
            accessKeyJustIssued: true,
        })
        // Emit issuance + payment events. The issuance event
        // carries the key token so operators can correlate it
        // with downstream redemption traffic.
        this.webhooks?.emit('access-key.issued', {
            tool: tool.name,
            key: decremented.key,
            ...(decremented.expiresAt !== null && {
                expiresAt: decremented.expiresAt,
            }),
            ...(decremented.remainingCalls !== null && {
                remainingCalls: decremented.remainingCalls,
            }),
            ...(receipt?.reference && { txHash: receipt.reference }),
        })
        this.webhooks?.emit('payment.received', {
            tool: tool.name,
            mode: 'access-key',
            amount: pricing.amount,
            ...(receipt?.reference && { txHash: receipt.reference }),
        })
        return attachAccessKey(withReceipt, decremented, true)
    }

    /** @internal Update stats for a successful paid call. */
    private recordPaidCall(toolName: string, amount: string, isSession = false): void {
        this.stats.totalCalls++
        this.stats.paidCalls++
        if (isSession) this.stats.sessionCalls++
        const calls = this.stats.callsByTool[toolName] ?? 0
        this.stats.callsByTool[toolName] = calls + 1

        // Accumulate revenue in base units (BigInt) for exactness, then
        // project the decimal-string view used by the public stats shape.
        const units = usdStringToBaseUnits(amount, REVENUE_DECIMALS)
        const prevToolUnits = this.revenueUnitsByTool.get(toolName) ?? 0n
        const nextToolUnits = prevToolUnits + units
        this.revenueUnitsByTool.set(toolName, nextToolUnits)
        this.totalRevenueUnits += units

        this.stats.revenueByTool[toolName] = baseUnitsToUsdString(
            nextToolUnits,
            REVENUE_DECIMALS
        )
        this.stats.totalRevenue = baseUnitsToUsdString(
            this.totalRevenueUnits,
            REVENUE_DECIMALS
        )
    }

    /** @internal Append an entry to the bounded call log. O(1). */
    private appendCall(entry: CallLogEntry): void {
        if (this.callLogCapacity === 0) return
        this.callLog[this.callLogWriteIndex] = entry
        this.callLogWriteIndex = (this.callLogWriteIndex + 1) % this.callLogCapacity
        if (this.callLogCount < this.callLogCapacity) {
            this.callLogCount++
        }
    }

    /**
     * Retrieve the most recent N calls in newest-first order. Used by the
     * dashboard's `/api/calls` endpoint and by callers that want to render
     * their own activity feed.
     *
     * Walks the ring buffer backwards from the most recent write, so the
     * result is always newest-first regardless of where in the buffer the
     * write head currently sits.
     */
    getRecentCalls(limit = 100): CallLogEntry[] {
        const n = Math.max(0, Math.min(limit, this.callLogCount))
        if (n === 0) return []
        const out: CallLogEntry[] = new Array(n)
        // Newest entry sits at (writeIndex - 1), walking back wraps to
        // capacity - 1 when we hit zero. Each entry we pass is one step
        // older than the previous.
        let cursor =
            (this.callLogWriteIndex - 1 + this.callLogCapacity) % this.callLogCapacity
        for (let i = 0; i < n; i++) {
            // Slot is guaranteed populated because i < callLogCount.
            out[i] = this.callLog[cursor] as CallLogEntry
            cursor = (cursor - 1 + this.callLogCapacity) % this.callLogCapacity
        }
        return out
    }

    /**
     * Start the server on a stdio transport (for local/CLI use).
     */
    async startStdio(): Promise<void> {
        const transport = new StdioServerTransport()
        await this.mcp.connect(transport)
    }

    /** Access the underlying McpServer for advanced integrations (HTTP, etc.). */
    get server(): McpServer {
        return this.mcp
    }

    /**
     * Number of tool calls currently being handled. Useful for
     * pre-shutdown observability — operators can watch this drop to
     * zero before signaling pod termination, or report it as a
     * Prometheus gauge.
     */
    getInFlightCount(): number {
        return this.inFlight
    }

    /**
     * Whether the gateway has begun shutting down. Once `true`, new
     * tool calls are rejected with {@link ShuttingDownError}.
     */
    isShuttingDown(): boolean {
        return this.shuttingDown
    }

    /**
     * Initiate a graceful shutdown.
     *
     * The shutdown sequence:
     *   1. Set `shuttingDown` so new tool calls are immediately
     *      rejected with {@link ShuttingDownError}. In-flight calls
     *      continue to completion.
     *   2. Fire the optional `onShutdown` hook (from constructor
     *      config), letting the operator close database connections,
     *      flush metrics, etc. Hook errors are logged but do not
     *      abort the shutdown.
     *   3. Wait for the in-flight counter to reach zero, polling at a
     *      short interval. If it doesn't reach zero within
     *      `timeoutMs`, throw {@link ShutdownTimeoutError} carrying
     *      the residual count.
     *   4. Disconnect the underlying MCP transport via `mcp.close()`.
     *
     * Idempotent: multiple concurrent calls share the same shutdown
     * promise and resolve/reject together.
     *
     * Recommended wiring under Kubernetes / Fly / similar:
     *
     * @example
     * ```ts
     * process.on('SIGTERM', async () => {
     *     try {
     *         await server.close({ timeoutMs: 25_000 })
     *         process.exit(0)
     *     } catch {
     *         process.exit(1)  // drain timed out
     *     }
     * })
     * ```
     */
    async close(options: { timeoutMs?: number } = {}): Promise<void> {
        // Idempotent: re-use the in-flight shutdown promise on repeat
        // calls. Two `close()` invocations from different signal
        // handlers must not double-fire `onShutdown`.
        if (this.closePromise) return this.closePromise

        const timeoutMs = options.timeoutMs ?? this.defaultDrainTimeoutMs
        this.shuttingDown = true
        this.closePromise = this.runShutdown(timeoutMs)
        return this.closePromise
    }

    /** @internal Drain + close. Called once via `close()`. */
    private async runShutdown(timeoutMs: number): Promise<void> {
        const log = this.logger.child({ phase: 'shutdown' })
        const drainStart = Date.now()
        log.info('shutdown initiated', {
            inFlight: this.inFlight,
            timeoutMs,
        })

        // Fire the user hook — error in the hook should not block the
        // drain. Any hook error gets logged at error level for
        // diagnostics; we still proceed to drain.
        if (this.onShutdown) {
            try {
                await this.onShutdown()
            } catch (err) {
                log.error('onShutdown hook threw — continuing drain', { err })
            }
        }

        // Drain loop. Poll the in-flight counter every 50ms until
        // either it hits zero or we exceed the timeout. We don't use
        // a single `setTimeout`-and-resolve construct because in-flight
        // calls finishing should let us exit early; a polling loop
        // gives us that.
        const deadline = drainStart + timeoutMs
        while (this.inFlight > 0 && Date.now() < deadline) {
            await sleep(50)
        }

        if (this.inFlight > 0) {
            const residual = this.inFlight
            log.error('drain timeout', { inFlight: residual, timeoutMs })
            throw new ShutdownTimeoutError({
                inFlight: residual,
                timeoutMs,
            })
        }

        log.info('drain complete', { durationMs: Date.now() - drainStart })

        // Drain pending webhook deliveries within the remaining
        // shutdown budget. We don't extend the deadline — webhook
        // dispatch is fire-and-forget by design and operators who
        // need durable delivery should mirror against their own
        // queue. But we make a best-effort wait so events emitted
        // late in the call stream (e.g. final session.closed) get
        // a fair chance to land before the process exits.
        if (this.webhooks && this.webhooks.inFlightCount() > 0) {
            log.info('draining webhooks', {
                pending: this.webhooks.inFlightCount(),
            })
            const remaining = deadline - Date.now()
            if (remaining > 0) {
                await Promise.race([
                    this.webhooks.drain(),
                    sleep(remaining),
                ])
            }
            const stillPending = this.webhooks.inFlightCount()
            if (stillPending > 0) {
                log.warn('webhooks did not finish draining', {
                    stillPending,
                })
            } else {
                log.info('webhook drain complete')
            }
        }

        // Disconnect the MCP transport. mcp.close() may not exist on
        // every SDK version; tolerate its absence.
        try {
            const closer = (this.mcp as unknown as { close?: () => Promise<void> }).close
            if (typeof closer === 'function') {
                await closer.call(this.mcp)
            }
        } catch (err) {
            log.warn('mcp.close threw', { err })
        }

        log.info('shutdown complete')
    }

    /** Current gateway statistics. */
    getStats(): GatewayStats {
        return {
            ...this.stats,
            uptimeMs: Date.now() - this.startTime,
        }
    }

    /** Get a listing of all tools with current prices. */
    listTools(): Array<{
        name: string
        description: string
        price: string | null
        inputSchema: Record<string, z.ZodTypeAny>
    }> {
        return [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            price: priceFor(t.pricing, this.stats.callsByTool[t.name] ?? 0),
            inputSchema: t.inputSchema,
        }))
    }

    /**
     * Full descriptor of every tool, including the raw `pricing` object.
     * Used by `mountDiscovery()` to build an OpenAPI document with
     * `x-payment-info` extensions per the MPP discovery spec.
     */
    describe(): {
        name: string
        version: string
        recipient: `0x${string}`
        currency: `0x${string}`
        network: 'mainnet' | 'testnet'
        tools: Array<{
            name: string
            description: string
            inputSchema: Record<string, z.ZodTypeAny>
            pricing?: PricingModel
        }>
    } {
        return {
            name: this.config.name,
            version: this.config.version,
            recipient: this.config.recipient,
            currency: this.config.currency,
            network: this.config.network,
            tools: [...this.tools.values()].map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
                ...(t.pricing && { pricing: t.pricing }),
            })),
        }
    }

    /** The network this server operates on. */
    getNetwork(): typeof TEMPO_MAINNET | typeof TEMPO_TESTNET {
        return this.config.network === 'mainnet' ? TEMPO_MAINNET : TEMPO_TESTNET
    }
}

/** @internal Create an Mppx payment handler configured for this server. */
function createMppxPayment(
    config: Required<
        Pick<PaidMcpServerConfig, 'currency' | 'network' | 'recipient' | 'secretKey'>
    > &
        PaidMcpServerConfig,
    logger: Logger
) {
    const useSessions = hasSessionPricing(config.tools)

    // tempo() with sessions enabled needs a Store and an escrow contract.
    // Without sessions we can keep things minimal — just charge.
    const tempoParams: Parameters<typeof tempo>[0] = {
        currency: config.currency,
        recipient: config.recipient,
        testnet: config.network === 'testnet',
    }

    if (config.feePayerKey) {
        tempoParams.feePayer = privateKeyToAccount(config.feePayerKey)
    }

    if (useSessions) {
        const escrow =
            config.escrowContract ??
            (config.network === 'mainnet' ? TEMPO_ESCROW_MAINNET : TEMPO_ESCROW_TESTNET)
        // Resolve the session store using the same logic as the
        // access-key store: native MppMcpStore → use directly, legacy
        // three-method → bridge, nothing → in-memory default. mppx
        // only consumes get/put/delete from the store, so any of the
        // three forms is structurally compatible.
        const store = resolveStore(config.sessionStore, logger)

            ; (tempoParams as Record<string, unknown>).escrowContract = escrow
            ; (tempoParams as Record<string, unknown>).store = store
            ; (tempoParams as Record<string, unknown>).stream = false
        // ^ stream:false → use the standard request/response session intent
        //   instead of the SSE long-poll variant. MCP tool calls are
        //   request/response, so this is the right shape.
    }

    return Mppx.create({
        methods: [tempo(tempoParams)],
        realm: config.name,
        secretKey: config.secretKey,
        transport: Transport.mcpSdk(),
    })
}

/**
 * @internal Resolve a user-supplied store config (or `undefined`) to a
 * native {@link MppMcpStore}. Three cases:
 *
 *   1. `undefined` → fresh in-memory store with atomic update.
 *   2. Already an `MppMcpStore` (has `update`) → use directly.
 *   3. Legacy three-method store (mppx's older `Store.Store`) → bridge
 *      with a best-effort `update` shim (logs a one-shot warning
 *      through the supplied logger).
 */
function resolveStore(input: unknown, logger?: Logger): MppMcpStore {
    if (input === undefined || input === null) return createMemoryStore()
    if (isMppMcpStore(input)) return input
    return bridgeMppxStore(
        input as Parameters<typeof bridgeMppxStore>[0],
        logger
    )
}

/** @internal Normalize a handler result into the MCP CallToolResult shape. */
function toMcpResult(result: ToolHandlerResult) {
    return {
        content: result.content,
        ...(result.data !== undefined && { structuredContent: result.data as never }),
    }
}

/**
 * @internal Stamp an access-key view into the result's `_meta`. The client
 * reads this back as `result.accessKey` in `PaidCallResult`.
 */
function attachAccessKey(
    result: Record<string, unknown>,
    record: AccessKeyRecord,
    justIssued: boolean
): Record<string, unknown> {
    const view = toClientView(record, justIssued)
    const existingMeta = (result._meta ?? {}) as Record<string, unknown>
    return {
        ...result,
        _meta: {
            ...existingMeta,
            [ACCESS_KEY_META]: view,
        },
    }
}

/**
 * @internal Distinguish a 402 payment-required error (control flow, not a
 * failure) from a real handler error. mppx throws an MCP `McpError` with
 * `code === paymentRequiredCode` for 402; everything else is a true failure.
 */
function isPaymentRequired(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false
    const obj = err as { code?: unknown; data?: { challenges?: unknown } }
    if (obj.code === -32042) return true
    if (obj.data && Array.isArray(obj.data.challenges)) return true
    return false
}

/** @internal Resolve after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @internal Read the MPP receipt payload (`{ method, reference,
 * timestamp }`) out of an MCP CallToolResult. Mppx attaches it to
 * `_meta['org.paymentauth/receipt']` after a successful settlement.
 * Returns undefined when no receipt is present (free / cached calls).
 */
function readReceipt(
    result: unknown
): { method?: string; reference?: string; timestamp?: string } | undefined {
    if (typeof result !== 'object' || result === null) return undefined
    const meta = (result as { _meta?: Record<string, unknown> })._meta
    if (!meta) return undefined
    const receipt = meta['org.paymentauth/receipt']
    if (typeof receipt !== 'object' || receipt === null) return undefined
    return receipt as { method?: string; reference?: string; timestamp?: string }
}

/**
 * @internal Read the stable error code off any thrown value, when
 * the value carries one. Library errors (`MppMcpError` subclasses)
 * set `code`; other errors don't, so this returns `undefined` for
 * arbitrary throws.
 */
function readErrorCode(err: unknown): string | undefined {
    if (typeof err !== 'object' || err === null) return undefined
    const candidate = (err as { code?: unknown }).code
    return typeof candidate === 'string' ? candidate : undefined
}

/**
 * Create a paid MCP server. Convenience factory — equivalent to
 * `new PaidMcpServer(config)`.
 */
export function createPaidMcpServer(config: PaidMcpServerConfig): PaidMcpServer {
    return new PaidMcpServer(config)
}
