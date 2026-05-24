/**
 * mpp-mcp-gateway — types
 *
 * Core types for monetizing MCP tools with MPP micropayments on Tempo.
 */

import type { z } from 'zod'

import type { Logger } from './logger.js'

/** Pricing model for a paid MCP tool. */
export type PricingModel =
    | { type: 'per-call'; amount: string }
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
    uptimeMs: number
    startedAt: string
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
