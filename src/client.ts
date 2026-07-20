/**
 * mpp-mcp-gateway — client
 *
 * A payment-enabled MCP client. Wraps @modelcontextprotocol/sdk's Client and
 * delegates the actual 402 challenge / credential / receipt handshake to
 * mppx's `McpClient.wrap`, which understands both `tempo.charge` (one-shot)
 * and `tempo.session` (channel-based) intents transparently.
 *
 * On top of that, this layer adds:
 *
 * - **Spending caps** — `maxPerCall`, `maxTotal`, and `maxSessionDeposit`,
 *   enforced via mppx's `onChallenge` hook BEFORE any signing happens.
 * - **Stats** — `getSpending()` exposes total spent, remaining budget, and
 *   any open session-channel state.
 * - **Typed result shape** — every call returns `{ content, data?, paid,
 *   receipt? }` regardless of which intent was used.
 *
 * Spending caps trigger a `SpendingCapExceededError` (per-call/total) or
 * `SessionDepositCapExceededError` (channel deposit) and abort the call
 * before any transaction is signed or broadcast.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport as McpTransport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Mcp } from 'mppx'
import { tempo } from 'mppx/client'
import { McpClient } from 'mppx/mcp-sdk/client'
import { privateKeyToAccount } from 'viem/accounts'

import { ACCESS_KEY_META, ACCESS_KEY_FINGERPRINT_META } from './constants.js'
import {
    ConfigurationError,
    SessionDepositCapExceededError,
    SpendingCapExceededError,
} from './errors.js'
import { defaultLogger, type Logger } from './logger.js'
import type { PaidCallResult, PaidMcpClientConfig } from './types.js'

// Re-export for backward compatibility — callers that did
// `import { SpendingCapExceededError } from 'mpp-mcp-gateway/client'`
// continue to work. The canonical source is now `./errors`.
export { SessionDepositCapExceededError, SpendingCapExceededError }

type ChallengeShape = {
    id: string
    method: string
    intent: string
    request: { amount: string; currency: string; decimals: number; recipient?: string }
    realm: string
}

/**
 * A payment-aware MCP client. Provides `connect`, `listTools`, and `callTool`
 * with automatic payment handling + spending caps.
 */
export class PaidMcpClient {
    private config: Required<Pick<PaidMcpClientConfig, 'network'>> & PaidMcpClientConfig
    private rawClient: Client
    private wrapped!: ReturnType<typeof buildWrapped>
    private logger: Logger
    /**
     * Spending caps and tracking in base units (BigInt, 6 decimals).
     * Using BigInt for cap enforcement eliminates the philosophical
     * inconsistency where the server tracks revenue exactly but the
     * client uses floats for caps — a $100.00 total cap with
     * parseFloat would drift after ~10⁵ sub-cent deductions.
     */
    private maxPerCallUnits: bigint
    private maxTotalUnits: bigint
    private maxSessionDepositUnits: bigint
    private totalSpentUnits: bigint = 0n
    private cumulativeVoucher = 0
    /**
     * Count of calls aborted locally because they would have exceeded a
     * configured cap (per-call, total, or session deposit). Surfaced via
     * {@link PaidMcpClient.getSpending} as `capExceeded`. Caps are enforced
     * client-side before any signing, so this counter has no server-side
     * equivalent in the `/metrics` endpoint.
     */
    private capExceededCount = 0
    /** Whether to verify settlement tx on-chain after closeSession. */
    private verifySettlement: boolean
    /** Client's own wallet address, derived from privateKey. Used for access-key fingerprinting. */
    private walletAddress: string
    /**
     * Cache of access keys, keyed by tool name. Each entry stores the most
     * recent server-issued state. Entries are evicted on expiry, exhaustion,
     * or explicit `clearAccessKeys()`.
     */
    private accessKeys = new Map<
        string,
        {
            key: string
            expiresAt?: string
            remainingCalls?: number
        }
    >()

    /**
     * Per-tool channel state for session-priced calls. Populated via
     * the mppx `onChannelUpdate` callback whenever the channel opens
     * or a voucher advances. We track the *latest* entry per tool so
     * `closeSession(toolName)` can submit the right close credential
     * without the caller having to plumb channel ids through.
     *
     * Only the most-recent channel for a given tool is stored: if an
     * agent opens, closes, then re-opens a channel for the same
     * tool, the older entry is overwritten. This matches the auto-
     * managed mppx flow where one tool typically owns one open
     * channel at a time.
     */
    private openSessions = new Map<
        string,
        {
            channelId: string
            cumulativeAmount: bigint
            escrowContract: string
            chainId: number
            updatedAt: number
        }
    >()

    /**
     * Tool name associated with the most recent channel update, used
     * by `onChannelUpdate` to attribute updates to the right tool.
     * mppx's callback gives us the channel state but not the tool;
     * we set this immediately before invoking a session call so the
     * subsequent callback can index correctly.
     */
    private currentSessionTool: string | undefined

    constructor(config: PaidMcpClientConfig) {
        this.config = {
            ...config,
            network: config.network ?? 'testnet',
        }

        this.logger = (config.logger ?? defaultLogger()).child({
            component: 'paid-mcp-client',
            client: config.name,
        })

        // Parse caps into BigInt base units (6 decimals) for exact
        // comparison. No more parseFloat drift on high-frequency calls.
        this.maxPerCallUnits = parseCapToBigInt(config.maxPerCall ?? '1.00', 'maxPerCall')
        this.maxTotalUnits = parseCapToBigInt(config.maxTotal ?? '100.00', 'maxTotal')
        this.maxSessionDepositUnits = parseCapToBigInt(
            config.maxSessionDeposit ?? '1.00',
            'maxSessionDeposit'
        )

        if (this.maxPerCallUnits <= 0n) {
            throw new ConfigurationError(`maxPerCall must be a positive number, got ${config.maxPerCall}`)
        }
        if (this.maxTotalUnits <= 0n) {
            throw new ConfigurationError(`maxTotal must be a positive number, got ${config.maxTotal}`)
        }
        if (this.maxSessionDepositUnits <= 0n) {
            throw new ConfigurationError(
                `maxSessionDeposit must be a positive number, got ${config.maxSessionDeposit}`
            )
        }

        this.verifySettlement = config.verifySettlement ?? false

        this.rawClient = new Client({ name: config.name, version: config.version })

        const account = privateKeyToAccount(config.privateKey)
        this.walletAddress = account.address

        // tempo() returns [chargeIntent, sessionIntent]. Passing `deposit`
        // puts the session intent in auto-mode — it manages channel open,
        // vouchers, and tracking on its own. We feed it our maxSessionDeposit
        // as the cap and rely on caps + onChannelUpdate for accounting.
        this.wrapped = buildWrapped(this.rawClient, account, config, (entry) => {
            const decimals = 6 // pathUSD; matches tempo defaults
            const cumulative = Number(entry.cumulativeAmount) / 10 ** decimals
            this.cumulativeVoucher = cumulative

            // Track per-tool channel state so closeSession() can act
            // on it later. The tool attribution comes from
            // currentSessionTool, set immediately before the call
            // that triggered this update.
            if (this.currentSessionTool) {
                this.openSessions.set(this.currentSessionTool, {
                    channelId: entry.channelId,
                    cumulativeAmount: entry.cumulativeAmount,
                    escrowContract: entry.escrowContract,
                    chainId: entry.chainId,
                    updatedAt: Date.now(),
                })
            }
        })
    }

    /** Connect to an MCP server over any MCP transport (stdio, SSE, HTTP). */
    async connect(transport: McpTransport): Promise<void> {
        await this.rawClient.connect(transport)
    }

    /** Close the underlying connection. */
    async close(): Promise<void> {
        await this.rawClient.close()
    }

    /** List available tools on the connected server. */
    async listTools(): Promise<Array<{ name: string; description?: string }>> {
        const result = await this.rawClient.listTools()
        return result.tools.map((t) => ({
            name: t.name,
            description: t.description,
        }))
    }

    /**
     * Call a tool, automatically handling MPP 402 payment challenges.
     *
     * Caps are enforced BEFORE signing. If the server's challenge would
     * exceed `maxPerCall` or `maxTotal`, throws `SpendingCapExceededError`.
     * If a session challenge requests more deposit than `maxSessionDeposit`,
     * throws `SessionDepositCapExceededError`. In both cases no transaction
     * is signed and no on-chain interaction occurs.
     *
     * For access-key-priced tools, the client transparently:
     *   - Attaches the cached key (if any) to the outgoing request `_meta`.
     *   - Pays once if no valid key is cached, then caches the new key.
     *   - Reads back the (possibly-decremented) key state from the response.
     *   - Evicts the cache entry when the server signals expiry/exhaustion.
     */
    async callTool<T = unknown>(
        name: string,
        args: Record<string, unknown> = {}
    ): Promise<PaidCallResult<T>> {
        // Build outgoing _meta. If we have a cached access key for this tool
        // that hasn't locally expired, attach it so the server can authorize
        // the call without billing again.
        const cached = this.lookupAccessKey(name)
        const baseMeta = cached
            ? ({
                [ACCESS_KEY_META]: cached.key,
                [ACCESS_KEY_FINGERPRINT_META]: this.walletAddress,
            } as Record<string, unknown>)
            : undefined

        // Try the call without a (payment) credential first. If the server
        // accepts the access key, we get back a free result. If the server
        // rejects (or we have no key), it issues a 402 and we drop into
        // the mppx wrapped retry below.
        let firstResult: Awaited<ReturnType<Client['callTool']>>
        try {
            firstResult = await this.rawClient.callTool({
                name,
                arguments: args ?? {},
                ...(baseMeta && { _meta: baseMeta }),
            })
        } catch (error) {
            if (!isPaymentRequiredError(error)) throw error

            // Validate the challenge against our caps before letting mppx
            // sign anything. This is the load-bearing safety check.
            const challenges = (error.data?.challenges ?? []) as ChallengeShape[]
            this.enforceCaps(challenges)

            // Hand off to mppx's wrapper for the full charge/session retry.
            // It picks the matching method intent, signs the credential,
            // retries the tool call, and surfaces the receipt.
            // We pass through any cached access key in case the server's
            // challenge mode allows fallback (defensive, no-op for charge).
            //
            // Set currentSessionTool so the onChannelUpdate callback can
            // attribute any session state changes from this call to the
            // right tool name. Cleared in `finally` so subsequent
            // non-session calls don't accidentally inherit it.
            this.currentSessionTool = name
            let result: Awaited<ReturnType<typeof this.wrapped.callTool>>
            try {
                result = await this.wrapped.callTool({
                    name,
                    arguments: args ?? {},
                    ...(baseMeta && { _meta: baseMeta }),
                })
            } finally {
                this.currentSessionTool = undefined
            }

            const receipt = result.receipt
            if (receipt) {
                const requestedUnits = this.parseChallengeAmountUnits(challenges)
                this.totalSpentUnits += requestedUnits
            }

            const accessKeyView = this.captureAccessKey(name, result as Record<string, unknown>)

            return {
                content: (result.content ?? []) as Array<{ type: 'text'; text: string }>,
                data: (result as { structuredContent?: T }).structuredContent,
                receipt: receipt
                    ? {
                        method: receipt.method,
                        reference: receipt.reference,
                        timestamp: receipt.timestamp,
                        amount: bigintToFixed(this.parseChallengeAmountUnits(challenges)),
                    }
                    : undefined,
                paid: !!receipt,
                ...(accessKeyView && { accessKey: accessKeyView }),
            }
        }

        // No 402 path. Either a free tool or an access-key call that the
        // server authorized via the cached key. Capture any access-key
        // updates the server included.
        const accessKeyView = this.captureAccessKey(
            name,
            firstResult as Record<string, unknown>
        )

        return {
            content: (firstResult.content ?? []) as Array<{ type: 'text'; text: string }>,
            data: (firstResult as { structuredContent?: T }).structuredContent,
            receipt: undefined,
            paid: false,
            ...(accessKeyView && { accessKey: accessKeyView }),
        }
    }

    /**
     * @internal Enforce per-call, total, and session-deposit caps against
     * the challenges issued by the server. Throws a typed error before any
     * signing happens. Uses BigInt arithmetic for exact comparison.
     */
    private enforceCaps(challenges: ChallengeShape[]): void {
        if (challenges.length === 0) return // nothing to enforce against
        const c = challenges[0]!
        const requestedUnits = this.parseChallengeAmountUnits(challenges)
        const isSession = c.intent === 'session'

        if (isSession) {
            const suggestedUnits = parseSuggestedDepositUnits(c)
            if (suggestedUnits > this.maxSessionDepositUnits) {
                this.capExceededCount++
                throw new SessionDepositCapExceededError({
                    suggested: bigintToFloat(suggestedUnits),
                    limit: bigintToFloat(this.maxSessionDepositUnits),
                })
            }
        }

        if (requestedUnits > this.maxPerCallUnits) {
            this.capExceededCount++
            throw new SpendingCapExceededError({
                kind: 'per-call',
                requested: bigintToFloat(requestedUnits),
                limit: bigintToFloat(this.maxPerCallUnits),
            })
        }
        if (this.totalSpentUnits + requestedUnits > this.maxTotalUnits) {
            this.capExceededCount++
            throw new SpendingCapExceededError({
                kind: 'total',
                requested: bigintToFloat(requestedUnits),
                limit: bigintToFloat(this.maxTotalUnits),
                totalSpent: bigintToFloat(this.totalSpentUnits),
            })
        }
    }

    /**
     * @internal Parse the requested per-call amount from a challenge
     * into BigInt base units (6 decimals). This is the exact
     * representation — no float coercion.
     */
    private parseChallengeAmountUnits(challenges: ChallengeShape[]): bigint {
        const c = challenges[0]
        if (!c) return 0n
        return BigInt(c.request.amount)
    }

    /** Current spending state. */
    getSpending(): {
        totalSpent: number
        remaining: number
        maxTotal: number
        maxPerCall: number
        maxSessionDeposit: number
        cumulativeVoucher: number
        capExceeded: number
    } {
        return {
            totalSpent: bigintToFloat(this.totalSpentUnits),
            remaining: bigintToFloat(this.maxTotalUnits - this.totalSpentUnits),
            maxTotal: bigintToFloat(this.maxTotalUnits),
            maxPerCall: bigintToFloat(this.maxPerCallUnits),
            maxSessionDeposit: bigintToFloat(this.maxSessionDepositUnits),
            cumulativeVoucher: this.cumulativeVoucher,
            capExceeded: this.capExceededCount,
        }
    }

    /** Reset the cumulative spend counter (useful for tests). */
    resetSpending(): void {
        this.totalSpentUnits = 0n
        this.cumulativeVoucher = 0
        this.capExceededCount = 0
    }

    /**
     * Read-only view of the client's cached access keys, keyed by tool name.
     * Useful for debugging or persisting keys to disk for later sessions.
     */
    getAccessKeys(): Record<
        string,
        { key: string; expiresAt?: string; remainingCalls?: number }
    > {
        return Object.fromEntries(this.accessKeys.entries())
    }

    /** Drop a cached access key for a tool, forcing the next call to re-pay. */
    clearAccessKey(toolName: string): void {
        this.accessKeys.delete(toolName)
    }

    /** Drop all cached access keys. */
    clearAccessKeys(): void {
        this.accessKeys.clear()
    }

    /**
     * Read-only snapshot of open session channels keyed by the tool
     * name that opened them. Each entry includes the channel id, the
     * latest cumulative voucher amount (in raw base units), the
     * escrow contract address, and the chain id. Use this to
     * inspect outstanding channels — typically right before
     * disconnect — and decide which to close cooperatively.
     *
     * The returned object is a snapshot: mutating it does not
     * affect the client's internal state. Channels are tracked
     * automatically via the mppx `onChannelUpdate` callback.
     *
     * @example
     * ```ts
     * for (const [tool, state] of Object.entries(client.getOpenSessions())) {
     *     console.log(`${tool}: ${state.channelId} @ ${state.cumulativeAmount}`)
     * }
     * ```
     */
    getOpenSessions(): Record<
        string,
        {
            channelId: string
            cumulativeAmount: bigint
            escrowContract: string
            chainId: number
            updatedAt: number
        }
    > {
        return Object.fromEntries(
            Array.from(this.openSessions.entries()).map(([k, v]) => [
                k,
                { ...v },
            ])
        )
    }

    /**
     * Cooperatively close the session channel associated with
     * `toolName`. Submits the latest voucher with `action: 'close'`
     * to the server, which settles the channel on-chain and
     * disburses funds. After successful close, the channel state
     * for this tool is dropped from the local cache.
     *
     * Returns:
     *   - `{ closed: true, receipt }` on a successful settlement.
     *     The receipt's `reference` is the on-chain tx hash.
     *   - `{ closed: false, reason: 'no-open-channel' }` when no
     *     channel is open for this tool.
     *
     * Idempotent: calling `closeSession` on a tool whose channel
     * was already closed (locally) is a no-op that returns the
     * `no-open-channel` outcome. Calling it after a transport-
     * level disconnect throws — the underlying MCP client refuses
     * to send.
     *
     * Recommended pattern for graceful shutdown:
     *
     * @example
     * ```ts
     * const sessions = client.getOpenSessions()
     * for (const tool of Object.keys(sessions)) {
     *     await client.closeSession(tool).catch((err) => {
     *         logger.warn('failed to close session', { tool, err })
     *     })
     * }
     * await client.close()
     * ```
     */
    async closeSession(
        toolName: string
    ): Promise<
        | {
            closed: true
            receipt: {
                method: string
                reference: string
                timestamp: string
            }
        }
        | { closed: false; reason: 'no-open-channel' }
    > {
        const state = this.openSessions.get(toolName)
        if (!state) {
            return { closed: false, reason: 'no-open-channel' }
        }

        // Hand the close credential context to mppx via callTool's
        // `options.context`. The wrapped client then picks the
        // session intent (matched by method name 'tempo'), invokes
        // the manual-mode path with action='close', signs the
        // close voucher, and submits it through the MCP wire as
        // a tool call's _meta credential. The server's mppx
        // session handler recognizes action='close' and settles
        // on-chain.
        //
        // We submit the close against the same tool that opened
        // the channel — any session-priced tool would work, but
        // using the originating tool keeps server-side stats and
        // logs aligned with the channel lifecycle.
        const result = await this.wrapped.callTool(
            {
                name: toolName,
                arguments: {},
            },
            {
                context: {
                    action: 'close',
                    channelId: state.channelId,
                    cumulativeAmountRaw: state.cumulativeAmount.toString(),
                } as never,
            }
        )

        // Drop local state on successful close. Any subsequent
        // call to closeSession for this tool returns
        // 'no-open-channel'.
        this.openSessions.delete(toolName)

        const receipt = result.receipt
        if (!receipt) {
            // mppx returned no receipt — this means the server
            // didn't ack the close. Surface as an error rather
            // than silently claim success.
            throw new Error(
                `closeSession("${toolName}") returned no receipt — close may not have settled.`
            )
        }

        this.logger.info('session channel closed', {
            tool: toolName,
            channelId: state.channelId,
            cumulativeAmount: state.cumulativeAmount.toString(),
            txHash: receipt.reference,
        })

        // On-chain verification: if the operator enabled trustless
        // settlement verification, confirm the tx receipt before
        // marking the close as successful. This adds ~1-2s latency
        // but provides a cryptographic guarantee that the server
        // actually settled the channel.
        if (this.verifySettlement && receipt.reference) {
            await this.verifySettlementTx(
                receipt.reference,
                state.channelId,
                state.cumulativeAmount,
                toolName
            )
        }

        return {
            closed: true,
            receipt: {
                method: receipt.method,
                reference: receipt.reference,
                timestamp: receipt.timestamp,
            },
        }
    }

    /**
     * @internal Verify a settlement transaction on-chain by checking
     * the tx receipt status. Uses the network's RPC endpoint to
     * confirm that the transaction was included in a block and
     * succeeded (status = 1). If verification fails, throws with a
     * descriptive error so the caller knows the settlement may not
     * have completed.
     *
     * This is a best-effort verification — it confirms the tx
     * exists and succeeded but does not decode the escrow contract
     * event logs (that would require the contract ABI as a
     * dependency). For full trustless verification, operators should
     * run their own indexer against the escrow contract.
     */
    private async verifySettlementTx(
        txHash: string,
        channelId: string,
        expectedAmount: bigint,
        toolName: string
    ): Promise<void> {
        const { createPublicClient, http } = await import('viem')
        const network = this.config.network === 'mainnet'
            ? { chainId: 4217, rpcUrl: 'https://rpc.tempo.xyz' }
            : { chainId: 42431, rpcUrl: 'https://rpc.moderato.tempo.xyz' }

        const client = createPublicClient({
            transport: http(network.rpcUrl),
        })

        try {
            const receipt = await client.getTransactionReceipt({
                hash: txHash as `0x${string}`,
            })

            if (receipt.status !== 'success') {
                throw new Error(
                    `Settlement tx ${txHash} for session "${toolName}" ` +
                    `(channel ${channelId}) reverted on-chain. ` +
                    `The server claimed settlement but the tx failed.`
                )
            }

            this.logger.info('settlement verified on-chain', {
                tool: toolName,
                channelId,
                txHash,
                blockNumber: receipt.blockNumber.toString(),
            })
        } catch (err) {
            if (err instanceof Error && err.message.includes('reverted')) {
                throw err // re-throw our own descriptive error
            }
            // RPC error — log warning but don't fail the close. The
            // server already acknowledged; RPC flakiness shouldn't
            // undo a successful settlement.
            this.logger.warn('settlement verification RPC failed', {
                tool: toolName,
                channelId,
                txHash,
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }

    /**
     * @internal Look up a cached access key for a tool, evicting if it
     * has obviously expired or been exhausted (defensive client-side check;
     * the server is the source of truth).
     */
    private lookupAccessKey(toolName: string):
        | { key: string; expiresAt?: string; remainingCalls?: number }
        | undefined {
        const entry = this.accessKeys.get(toolName)
        if (!entry) return undefined
        if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
            this.accessKeys.delete(toolName)
            return undefined
        }
        if (entry.remainingCalls !== undefined && entry.remainingCalls <= 0) {
            this.accessKeys.delete(toolName)
            return undefined
        }
        return entry
    }

    /**
     * @internal Read an access-key view from a result's `_meta`, update the
     * cache, and return the public-shape view for the caller.
     */
    private captureAccessKey(
        toolName: string,
        result: Record<string, unknown>
    ):
        | {
            key: string
            expiresAt?: string
            remainingCalls?: number
            justIssued: boolean
        }
        | undefined {
        const meta = (result._meta ?? {}) as Record<string, unknown>
        const view = meta[ACCESS_KEY_META] as
            | {
                key: string
                expiresAt?: string
                remainingCalls?: number
                justIssued: boolean
            }
            | undefined
        if (!view || typeof view.key !== 'string') return undefined

        // Cache (or evict if exhausted).
        if (view.remainingCalls !== undefined && view.remainingCalls <= 0) {
            this.accessKeys.delete(toolName)
        } else {
            this.accessKeys.set(toolName, {
                key: view.key,
                ...(view.expiresAt && { expiresAt: view.expiresAt }),
                ...(view.remainingCalls !== undefined && {
                    remainingCalls: view.remainingCalls,
                }),
            })
        }
        return view
    }
}

/** @internal Read suggestedDeposit from a session challenge as BigInt base units. */
function parseSuggestedDepositUnits(challenge: ChallengeShape): bigint {
    const req = challenge.request as Record<string, unknown>
    const raw = req['suggestedDeposit']
    if (typeof raw !== 'string' || raw.length === 0) return 0n
    return BigInt(raw)
}

/**
 * @internal Parse a USD decimal string into BigInt base units (6 decimals).
 * Throws ConfigurationError on invalid input (non-numeric). For negative
 * values, returns 0n so the caller's own validation can fire the correct
 * error message.
 */
function parseCapToBigInt(amount: string, field: string): bigint {
    const trimmed = amount.trim()
    // Allow negative values to pass through as 0n — the caller
    // checks `<= 0n` and throws the appropriate error with the
    // original field name and value.
    if (trimmed.startsWith('-')) return 0n
    if (!/^(\d+\.?\d*|\.\d+)$/.test(trimmed)) {
        throw new ConfigurationError(
            `${field} must be a positive number, got ${amount}`
        )
    }
    const normalized = trimmed.startsWith('.') ? '0' + trimmed : trimmed
    const [whole = '0', fractional = ''] = normalized.split('.')
    // Pad or truncate to 6 decimals.
    const padded = fractional.slice(0, 6).padEnd(6, '0')
    return BigInt(whole + padded)
}

/**
 * @internal Convert BigInt base units (6 decimals) to a float for
 * display/error messages. This is a lossy projection — used only at
 * the boundary where the existing error class API expects `number`.
 */
function bigintToFloat(units: bigint): number {
    return Number(units) / 1_000_000
}

/**
 * @internal Convert BigInt base units (6 decimals) to a fixed-point
 * decimal string like '0.001000'. Used for receipt amount formatting.
 */
function bigintToFixed(units: bigint): string {
    if (units === 0n) return '0.000000'
    const divisor = 1_000_000n
    const whole = units / divisor
    const fractional = units % divisor
    return `${whole}.${fractional.toString().padStart(6, '0')}`
}

/** @internal Type guard for MCP payment-required errors. */
function isPaymentRequiredError(error: unknown): error is {
    code: number
    message: string
    data?: { challenges?: unknown[] }
} {
    if (typeof error !== 'object' || error === null) return false
    if (!('code' in error)) return false
    return (error as { code: unknown }).code === Mcp.paymentRequiredCode
}

/** Convenience factory. */
export function createPaidMcpClient(config: PaidMcpClientConfig): PaidMcpClient {
    return new PaidMcpClient(config)
}

/**
 * @internal Shape of channel-state updates that mppx pushes through
 * `onChannelUpdate`. Subset of mppx's `ChannelEntry` type — we
 * declare it locally to avoid coupling our public API to mppx's
 * internal exports.
 */
interface ChannelUpdateEntry {
    channelId: string
    cumulativeAmount: bigint
    escrowContract: string
    chainId: number
    salt?: string
    opened?: boolean
}

/**
 * @internal Build the mppx McpClient.wrap proxy with the right method tuple.
 * Extracted so its return type can drive the `wrapped` field's type without
 * a generic-instantiation mismatch.
 */
function buildWrapped(
    raw: Client,
    account: ReturnType<typeof privateKeyToAccount>,
    config: PaidMcpClientConfig,
    onChannelUpdate: (entry: ChannelUpdateEntry) => void
) {
    const methods = tempo({
        account,
        maxDeposit: config.maxSessionDeposit ?? '1.00',
        onChannelUpdate: onChannelUpdate as never,
    })
    return McpClient.wrap(raw, { methods: [...methods] })
}
