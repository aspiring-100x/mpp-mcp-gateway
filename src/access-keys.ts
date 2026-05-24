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
 * Storage uses {@link MppMcpStore}, a small four-method interface with
 * three native adapters (memory, Upstash, Cloudflare KV) and a bridge
 * for legacy three-method stores. See `src/stores/` for details.
 *
 * Concurrency: `redeem` performs the counter decrement via the store's
 * atomic `update` primitive. With the in-memory or Upstash adapters
 * this guarantees that 50 concurrent redeems of a 50-call key result
 * in exactly 50 successes and the rest fail with `exhausted` — no
 * lost-update races. The Cloudflare KV adapter cannot enforce this
 * across regions; see its module docstring for the trade-off.
 */

import { randomBytes } from 'node:crypto'

import { ConfigurationError, InternalError, ValidationError } from './errors.js'
import type { MppMcpStore } from './stores/types.js'
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
        throw new ValidationError(
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
        default: throw new InternalError(`unreachable unit ${unit}`)
    }
}

/** Validate access-key pricing config — at least one bound is required. */
export function validateAccessKeyPricing(
    toolName: string,
    pricing: Extract<PricingModel, { type: 'access-key' }>
): void {
    if (pricing.validFor === undefined && pricing.maxCalls === undefined) {
        throw new ConfigurationError(
            `Tool "${toolName}" uses access-key pricing but specifies neither validFor nor maxCalls. ` +
            `At least one bound is required to prevent unbounded free access after a single payment.`
        )
    }
    if (pricing.validFor !== undefined) parseDuration(pricing.validFor) // validates format
    if (pricing.maxCalls !== undefined && !(Number.isInteger(pricing.maxCalls) && pricing.maxCalls > 0)) {
        throw new ConfigurationError(
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
 * Atomically redeem one call against an access key. On success returns
 * the updated record; on failure returns a typed reason so the caller
 * can decide whether to fall back to the pay flow.
 *
 * Atomicity: the entire read-validate-decrement-write cycle runs
 * inside the store's `update` primitive. Concurrent redeems of the
 * same key serialize cleanly — exactly `remainingCalls` of them
 * succeed (modulo backend consistency; see store-specific docs).
 *
 * Sticky terminal states: `redeem` does NOT delete records on
 * `expired` or `exhausted`. Removing them would create a race where
 * concurrent redeems see one as the terminal reason and the next as
 * `unknown` (record absent because someone else just deleted it).
 * Instead, terminal records sit in the store and consistently return
 * the same reason for every observer. Backends with TTL support
 * (Upstash, Cloudflare KV) clean them up automatically; in-memory
 * stores accumulate them until process restart, which is fine for
 * realistic working set sizes.
 *
 * To preserve the typed reason while still using `update`, we use a
 * captured-outcome pattern: the transform writes its decision into a
 * closure variable on each invocation, and only the LAST invocation's
 * decision corresponds to the value that actually got persisted. On
 * the in-memory adapter the transform runs exactly once. On Upstash
 * with concurrent contention the transform may run multiple times.
 */
export async function redeem(
    store: MppMcpStore,
    key: string,
    toolName: string
): Promise<RedeemResult> {
    /**
     * The transform's chosen outcome. Captured in this variable so the
     * caller (this function) can return it after `update` resolves. We
     * reset it to a sentinel before each redeem so a failure mode
     * isn't accidentally inherited from a previous call.
     */
    let outcome: RedeemResult = { ok: false, reason: 'unknown' }

    await store.update<AccessKeyRecord>(key, (record) => {
        if (!record) {
            outcome = { ok: false, reason: 'unknown' }
            return null // nothing to write; key remains absent
        }

        if (record.tool !== toolName) {
            outcome = { ok: false, reason: 'wrong-tool' }
            return record // leave the record untouched
        }

        if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
            outcome = { ok: false, reason: 'expired' }
            return record // sticky: keep the record, every observer sees 'expired'
        }

        if (record.remainingCalls !== null) {
            if (record.remainingCalls <= 0) {
                outcome = { ok: false, reason: 'exhausted' }
                return record // sticky: keep the record, every observer sees 'exhausted'
            }
            const next: AccessKeyRecord = {
                ...record,
                remainingCalls: record.remainingCalls - 1,
            }
            outcome = { ok: true, record: next }
            return next
        }

        // Unlimited-calls record: count not decremented, record unchanged.
        outcome = { ok: true, record }
        return record
    })

    return outcome
}

/** Persist a freshly issued record. */
export async function storeRecord(
    store: MppMcpStore,
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
