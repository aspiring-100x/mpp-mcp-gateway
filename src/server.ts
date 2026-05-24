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
import {
    bridgeMppxStore,
    createMemoryStore,
    isMppMcpStore,
    type MppMcpStore,
} from './stores/index.js'
import type {
    CallLogEntry,
    GatewayStats,
    PaidMcpServerConfig,
    PaidToolDefinition,
    PricingModel,
    ToolHandlerResult,
} from './types.js'

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

        // Validate access-key pricing up-front so misconfiguration fails fast.
        for (const tool of config.tools) {
            if (tool.pricing?.type === 'access-key') {
                validateAccessKeyPricing(tool.name, tool.pricing)
            }
        }

        // Resolve the access-key store. Three cases:
        //   1. User passed a four-method MppMcpStore → use directly.
        //   2. User passed a legacy three-method store → bridge it
        //      (best-effort `update`, with a one-shot warning).
        //   3. Nothing passed → in-memory default with atomic update.
        this.accessKeyStore = resolveStore(config.accessKeyStore)

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
        this.mppx = createMppxPayment(this.config)

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
            const start = Date.now()
            const currentCalls = this.stats.callsByTool[tool.name] ?? 0

            try {
                // Free tool — no payment flow.
                if (!tool.pricing) {
                    this.stats.totalCalls++
                    this.stats.freeCalls++
                    this.stats.callsByTool[tool.name] = currentCalls + 1
                    const result = await tool.handler(args)
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
                    return await this.runAccessKey(tool, args, extra, start)
                }

                // Paid path — choose the right intent.
                if (tool.pricing.type === 'session') {
                    return await this.runSession(tool, args, extra, start)
                }

                // per-call / tiered → charge intent
                const amount = priceFor(tool.pricing, currentCalls)!
                const charge = this.mppx.charge({
                    amount,
                    currency,
                    recipient,
                    description: tool.description,
                })

                const outcome = await charge(extra)
                if (outcome.status === 402) throw outcome.challenge

                const result = await tool.handler(args)
                this.recordPaidCall(tool.name, amount)
                this.appendCall({
                    tool: tool.name,
                    timestamp: new Date().toISOString(),
                    durationMs: Date.now() - start,
                    paid: true,
                    paymentMode: tool.pricing.type, // 'per-call' | 'tiered'
                    amount,
                })
                return outcome.withReceipt(toMcpResult(result))
            } catch (err) {
                // 402 challenges flow through the catch but they aren't real
                // failures — they're control-flow signals to the client. We
                // detect them by the presence of `data.challenges` and skip
                // logging them as errors.
                if (!isPaymentRequired(err)) {
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
                        error:
                            err instanceof Error
                                ? err.message
                                : String(err ?? 'unknown error'),
                    })
                }
                throw err
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
        start: number
    ): Promise<unknown> {
        if (tool.pricing?.type !== 'session') {
            throw new Error(
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
            throw new Error(
                `Session pricing requires escrowContract / store wiring. ` +
                `If you intentionally use session pricing, ensure the server ` +
                `was constructed with at least one session-priced tool so ` +
                `mppx is configured correctly.`
            )
        }

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

        const outcome = await session(extra)
        if (outcome.status === 402) throw outcome.challenge

        const result = await tool.handler(args)

        // Inspect the inbound credential to understand what just happened on
        // the channel — open / topUp / voucher / close — and update stats.
        // The mcp-sdk server transport places the already-deserialized
        // Credential object at extra._meta[credentialMetaKey], so we read
        // it directly rather than re-deserializing.
        try {
            const cred = (extra._meta as Record<string, unknown> | undefined)?.[
                'org.paymentauth/credential'
            ] as { payload?: { action?: string } } | undefined
            const action = cred?.payload?.action
            if (action === 'open') this.stats.sessionsOpened++
            if (action === 'close') this.stats.sessionsClosed++
        } catch {
            // Stats are best-effort. A malformed credential would have been
            // rejected by mppx.session() before we got here.
        }

        this.recordPaidCall(tool.name, tool.pricing.amount, true)
        this.appendCall({
            tool: tool.name,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - start,
            paid: true,
            paymentMode: 'session',
            amount: tool.pricing.amount,
        })
        return outcome.withReceipt(toMcpResult(result))
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
        start: number
    ): Promise<unknown> {
        if (tool.pricing?.type !== 'access-key') {
            throw new Error(
                `runAccessKey called on tool with non-access-key pricing: ${tool.name}`
            )
        }
        const pricing = tool.pricing
        const incomingKey = (extra._meta as Record<string, unknown> | undefined)?.[
            ACCESS_KEY_META
        ]

        if (typeof incomingKey === 'string' && incomingKey.length > 0) {
            const outcome = await redeem(this.accessKeyStore, incomingKey, tool.name)
            if (outcome.ok) {
                // Free call against a valid key.
                const result = await tool.handler(args)
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
            }
            // Fall through to the pay flow — agent will need to pay again.
        }

        // No key (or rejected). Charge the upfront fee.
        const charge = this.mppx.charge({
            amount: pricing.amount,
            currency: this.config.currency,
            recipient: this.config.recipient,
            description: `${tool.description} (issues access key)`,
        })

        const outcome = await charge(extra)
        if (outcome.status === 402) throw outcome.challenge

        // Payment cleared. Run the handler, then issue a new key.
        const result = await tool.handler(args)
        const record = issueRecord({
            toolName: tool.name,
            pricing,
        })
        await storeRecord(this.accessKeyStore, record)
        this.stats.accessKeysIssued++

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
        this.appendCall({
            tool: tool.name,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - start,
            paid: true,
            paymentMode: 'access-key',
            amount: pricing.amount,
            accessKeyJustIssued: true,
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
        PaidMcpServerConfig
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
        const store = resolveStore(config.sessionStore)

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
 *      with a best-effort `update` shim (logs a one-shot warning).
 */
function resolveStore(input: unknown): MppMcpStore {
    if (input === undefined || input === null) return createMemoryStore()
    if (isMppMcpStore(input)) return input
    return bridgeMppxStore(input as Parameters<typeof bridgeMppxStore>[0])
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

/**
 * Create a paid MCP server. Convenience factory — equivalent to
 * `new PaidMcpServer(config)`.
 */
export function createPaidMcpServer(config: PaidMcpServerConfig): PaidMcpServer {
    return new PaidMcpServer(config)
}
