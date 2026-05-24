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

import { ACCESS_KEY_META } from './constants.js'
import {
    ConfigurationError,
    SessionDepositCapExceededError,
    SpendingCapExceededError,
} from './errors.js'
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
    private maxPerCall: number
    private maxTotal: number
    private maxSessionDeposit: number
    private totalSpent = 0
    private cumulativeVoucher = 0
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

    constructor(config: PaidMcpClientConfig) {
        this.config = {
            ...config,
            network: config.network ?? 'testnet',
        }

        this.maxPerCall = parseFloat(config.maxPerCall ?? '1.00')
        this.maxTotal = parseFloat(config.maxTotal ?? '100.00')
        this.maxSessionDeposit = parseFloat(config.maxSessionDeposit ?? '1.00')

        if (!(this.maxPerCall > 0)) {
            throw new ConfigurationError(`maxPerCall must be a positive number, got ${config.maxPerCall}`)
        }
        if (!(this.maxTotal > 0)) {
            throw new ConfigurationError(`maxTotal must be a positive number, got ${config.maxTotal}`)
        }
        if (!(this.maxSessionDeposit > 0)) {
            throw new ConfigurationError(
                `maxSessionDeposit must be a positive number, got ${config.maxSessionDeposit}`
            )
        }

        this.rawClient = new Client({ name: config.name, version: config.version })

        const account = privateKeyToAccount(config.privateKey)

        // tempo() returns [chargeIntent, sessionIntent]. Passing `deposit`
        // puts the session intent in auto-mode — it manages channel open,
        // vouchers, and tracking on its own. We feed it our maxSessionDeposit
        // as the cap and rely on caps + onChannelUpdate for accounting.
        this.wrapped = buildWrapped(this.rawClient, account, config, (entry) => {
            const decimals = 6 // pathUSD; matches tempo defaults
            const cumulative = Number(entry.cumulativeAmount) / 10 ** decimals
            this.cumulativeVoucher = cumulative
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
            ? ({ [ACCESS_KEY_META]: cached.key } as Record<string, unknown>)
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
            const result = await this.wrapped.callTool({
                name,
                arguments: args ?? {},
                ...(baseMeta && { _meta: baseMeta }),
            })

            const receipt = result.receipt
            if (receipt) {
                const requested = this.parseChallengeAmount(challenges)
                this.totalSpent += requested
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
                        amount: this.parseChallengeAmount(challenges).toFixed(6),
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
     * signing happens.
     */
    private enforceCaps(challenges: ChallengeShape[]): void {
        if (challenges.length === 0) return // nothing to enforce against
        const c = challenges[0]!
        const requested = this.parseChallengeAmount(challenges)
        const isSession = c.intent === 'session'

        if (isSession) {
            // Session challenges include a `suggestedDeposit` (raw units).
            // The deposit is what the client locks into escrow up-front, so
            // we need a separate cap for it.
            const suggested = parseSuggestedDeposit(c)
            if (suggested > this.maxSessionDeposit) {
                throw new SessionDepositCapExceededError({
                    suggested,
                    limit: this.maxSessionDeposit,
                })
            }
            // For per-call/total caps, the per-unit price still applies.
        }

        if (requested > this.maxPerCall) {
            throw new SpendingCapExceededError({
                kind: 'per-call',
                requested,
                limit: this.maxPerCall,
            })
        }
        if (this.totalSpent + requested > this.maxTotal) {
            throw new SpendingCapExceededError({
                kind: 'total',
                requested,
                limit: this.maxTotal,
                totalSpent: this.totalSpent,
            })
        }
    }

    /** @internal Parse the requested per-call amount from a challenge into USD. */
    private parseChallengeAmount(challenges: ChallengeShape[]): number {
        const c = challenges[0]
        if (!c) return 0
        const decimals = c.request.decimals ?? 6
        const raw = BigInt(c.request.amount)
        const divisor = 10n ** BigInt(decimals)
        const whole = Number(raw / divisor)
        const fractional = Number(raw % divisor) / Number(divisor)
        return whole + fractional
    }

    /** Current spending state. */
    getSpending(): {
        totalSpent: number
        remaining: number
        maxTotal: number
        maxPerCall: number
        maxSessionDeposit: number
        cumulativeVoucher: number
    } {
        return {
            totalSpent: this.totalSpent,
            remaining: this.maxTotal - this.totalSpent,
            maxTotal: this.maxTotal,
            maxPerCall: this.maxPerCall,
            maxSessionDeposit: this.maxSessionDeposit,
            cumulativeVoucher: this.cumulativeVoucher,
        }
    }

    /** Reset the cumulative spend counter (useful for tests). */
    resetSpending(): void {
        this.totalSpent = 0
        this.cumulativeVoucher = 0
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

/** @internal Read suggestedDeposit from a session challenge into USD. */
function parseSuggestedDeposit(challenge: ChallengeShape): number {
    const req = challenge.request as Record<string, unknown>
    const raw = req['suggestedDeposit']
    if (typeof raw !== 'string' || raw.length === 0) return 0
    const decimals = (req['decimals'] as number | undefined) ?? 6
    const big = BigInt(raw)
    const divisor = 10n ** BigInt(decimals)
    const whole = Number(big / divisor)
    const fractional = Number(big % divisor) / Number(divisor)
    return whole + fractional
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
 * @internal Build the mppx McpClient.wrap proxy with the right method tuple.
 * Extracted so its return type can drive the `wrapped` field's type without
 * a generic-instantiation mismatch.
 */
function buildWrapped(
    raw: Client,
    account: ReturnType<typeof privateKeyToAccount>,
    config: PaidMcpClientConfig,
    onChannelUpdate: (entry: { cumulativeAmount: bigint }) => void
) {
    const methods = tempo({
        account,
        maxDeposit: config.maxSessionDeposit ?? '1.00',
        onChannelUpdate: onChannelUpdate as never,
    })
    return McpClient.wrap(raw, { methods: [...methods] })
}
