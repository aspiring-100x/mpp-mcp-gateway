/**
 * mpp-mcp-gateway — access keys
 *
 * An access key is a server-issued opaque token that authorizes free tool
 * calls until it expires (`validFor`) or runs out (`maxCalls`). The agent
 * pays once via a normal `tempo.charge`, the server stores a record of the
 * key's parameters, and subsequent calls present the key in MCP `_meta`
 * instead of paying again.
 *
 * Wire format on success:
 *   - Server response `_meta[ACCESS_KEY_META]` includes `{ key, expiresAt?, remainingCalls? }`
 *
 * Wire format on subsequent calls:
 *   - Client request `_meta[ACCESS_KEY_META] = key` — just the opaque string
 *
 * Storage uses the same `Store.Store` interface mppx uses for sessions so
 * users can swap in Redis/D1/Durable Objects without writing a new adapter.
 */

import { randomBytes } from 'node:crypto'
import { Store } from 'mppx/server'

import type { PricingModel } from './types.js'

/** Persistent record for an issued access key. */
export interface AccessKeyRecord {
    /** The opaque token (also the store key). */
    key: string
    /** Tool name this key authorizes. Keys are scoped per-tool. */
    tool: string
    /** ISO 8601 timestamp when this key was issued. */
    issuedAt: string
    /** ISO 8601 timestamp when this key expires, or `null` for no time limit. */
    expiresAt: string | null
    /** Calls remaining, or `null` for no count limit. */
    remainingCalls: number | null
    /** Tx hash of the original payment, for auditing. */
    paymentReference?: string
}

/** Parse a compact duration string like '7d', '30m', '4h', '60s' into milliseconds. */
export function parseDuration(input: string): number {
    const m = /^(\d+)\s*(s|m|h|d)$/.exec(input.trim())
    if (!m) {
        throw new Error(
            `Invalid validFor duration "${input}". Expected forms like '60s', '15m', '4h', '7d'.`
        )
    }
    const n = Number(m[1])
    const unit = m[2]
    switch (unit) {
        case 's': return n * 1000
        case 'm': return n * 60_000
        case 'h': return n * 3_600_000
        case 'd': return n * 86_400_000
        default: throw new Error(`unreachable unit ${unit}`)
    }
}

/** Validate access-key pricing config — at least one bound is required. */
export function validateAccessKeyPricing(
    toolName: string,
    pricing: Extract<PricingModel, { type: 'access-key' }>
): void {
    if (pricing.validFor === undefined && pricing.maxCalls === undefined) {
        throw new Error(
            `Tool "${toolName}" uses access-key pricing but specifies neither validFor nor maxCalls. ` +
            `At least one bound is required to prevent unbounded free access after a single payment.`
        )
    }
    if (pricing.validFor !== undefined) parseDuration(pricing.validFor) // validates format
    if (pricing.maxCalls !== undefined && !(Number.isInteger(pricing.maxCalls) && pricing.maxCalls > 0)) {
        throw new Error(
            `Tool "${toolName}" has invalid maxCalls=${pricing.maxCalls}. Must be a positive integer.`
        )
    }
}

/** Build a fresh AccessKeyRecord from a pricing config. */
export function issueRecord(args: {
    toolName: string
    pricing: Extract<PricingModel, { type: 'access-key' }>
    paymentReference?: string
}): AccessKeyRecord {
    const now = Date.now()
    // 32 bytes of crypto randomness — keys look like `mppmcp_<hex>`.
    const key = `mppmcp_${randomBytes(32).toString('hex')}`
    const expiresAt = args.pricing.validFor
        ? new Date(now + parseDuration(args.pricing.validFor)).toISOString()
        : null
    const remainingCalls = args.pricing.maxCalls ?? null
    return {
        key,
        tool: args.toolName,
        issuedAt: new Date(now).toISOString(),
        expiresAt,
        remainingCalls,
        paymentReference: args.paymentReference,
    }
}

/** Outcome of attempting to redeem (use) an access key for a tool call. */
export type RedeemResult =
    | { ok: true; record: AccessKeyRecord }
    | { ok: false; reason: 'unknown' | 'wrong-tool' | 'expired' | 'exhausted' }

/**
 * Atomically redeem one call against an access key. On success returns the
 * updated record; on failure returns a typed reason so the caller can decide
 * whether to fall back to the pay flow.
 */
export async function redeem(
    store: Store.Store,
    key: string,
    toolName: string
): Promise<RedeemResult> {
    const record = await store.get<AccessKeyRecord>(key)
    if (!record) return { ok: false, reason: 'unknown' }
    if (record.tool !== toolName) return { ok: false, reason: 'wrong-tool' }

    // Time check
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
        await store.delete(key)
        return { ok: false, reason: 'expired' }
    }

    // Count check
    if (record.remainingCalls !== null) {
        if (record.remainingCalls <= 0) {
            await store.delete(key)
            return { ok: false, reason: 'exhausted' }
        }
        const next: AccessKeyRecord = { ...record, remainingCalls: record.remainingCalls - 1 }
        await store.put(key, next)
        // Auto-revoke when the *next* call would have nothing left to give.
        // (We just decremented to >= 0; keep the record around so a final
        // call can still see remainingCalls === 0 in its receipt.)
        return { ok: true, record: next }
    }

    return { ok: true, record }
}

/** Persist a freshly issued record. */
export async function storeRecord(
    store: Store.Store,
    record: AccessKeyRecord
): Promise<void> {
    await store.put(record.key, record)
}

/** Public projection of a record — what we send to the client. */
export function toClientView(record: AccessKeyRecord, justIssued: boolean): {
    key: string
    expiresAt?: string
    remainingCalls?: number
    justIssued: boolean
} {
    return {
        key: record.key,
        ...(record.expiresAt !== null && { expiresAt: record.expiresAt }),
        ...(record.remainingCalls !== null && { remainingCalls: record.remainingCalls }),
        justIssued,
    }
}
