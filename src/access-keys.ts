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
 *   - Under `accessKeyBinding: 'wallet'`, also
 *     `_meta[ACCESS_KEY_FINGERPRINT_META] = <wallet address>`
 *
 * Binding fails closed in both directions. `issueRecord` refuses to mint
 * a record when binding is on but no payer address is known, and
 * `redeem` refuses a record that carries no binding when the server
 * requires one. Neither path degrades to a bearer token, because a
 * bearer token is exactly what an attacker who intercepted the key
 * needs.
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

import { ConfigurationError, InternalError, ValidationError } from './errors.js'
import { randomHex } from './runtime.js'
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
    /**
     * Wallet address of the client that paid for this key, lowercased.
     * When set, only requests whose `_meta` carries a matching
     * fingerprint are authorized — prevents stolen keys from being
     * replayed by a different agent.
     *
     * Set via `PaidMcpServerConfig.accessKeyBinding: 'wallet'`. Under
     * that mode this field is *mandatory*: {@link issueRecord} refuses
     * to mint a record without it rather than fall back to a bearer
     * token. When binding is `'none'` (the default for backward
     * compat), this field is `undefined` and no fingerprint check runs.
     */
    boundTo?: string
}

/**
 * Normalize a wallet address for binding comparisons, or return
 * `undefined` if the value isn't a syntactically valid 20-byte hex
 * address.
 *
 * Two reasons this exists:
 *
 * 1. **Case.** Ethereum addresses are case-insensitive on the wire;
 *    EIP-55 uses casing only as a checksum. viem hands the client a
 *    checksummed (mixed-case) address while a payment credential may
 *    carry a lowercased one, so a case-sensitive comparison would
 *    reject legitimate clients. We compare lowercased forms.
 * 2. **Validity.** A key must never be bound to a garbage value. An
 *    empty string, a truncated address, or a non-string all read as
 *    "payer unknown" so callers fail closed instead of minting a
 *    record whose binding can never match anything.
 */
export function normalizeWalletAddress(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return undefined
    return trimmed.toLowerCase()
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

/**
 * Build a fresh AccessKeyRecord from a pricing config.
 *
 * Fails closed under wallet binding: if `binding` is `'wallet'` and no
 * usable `boundTo` address is supplied, this throws instead of minting
 * an unbound record. Silently dropping the binding would downgrade the
 * key to a bearer token that any holder could replay — the exact
 * property `accessKeyBinding: 'wallet'` is configured to prevent.
 */
export function issueRecord(args: {
    toolName: string
    pricing: Extract<PricingModel, { type: 'access-key' }>
    paymentReference?: string
    /**
     * Binding mode in force for this issuance. Under `'wallet'` a
     * valid `boundTo` address is required. Defaults to `'none'`
     * (bearer keys) to match the server default.
     */
    binding?: 'none' | 'wallet'
    /** When binding is enabled, the wallet address to lock this key to. */
    boundTo?: string
}): AccessKeyRecord {
    const boundTo = normalizeWalletAddress(args.boundTo)
    if (args.binding === 'wallet' && boundTo === undefined) {
        // Callers must resolve the payer before minting. The server does
        // this in `runAccessKey` and reports a caller-facing error; if we
        // get here the invariant leaked, so refuse rather than weaken the
        // key.
        throw new InternalError(
            `Refusing to issue an access key for "${args.toolName}": binding is 'wallet' but no valid ` +
            `payer address was supplied (got ${JSON.stringify(args.boundTo)}). An unbound key would be ` +
            `redeemable by any holder, so issuance fails closed instead.`
        )
    }
    const now = Date.now()
    // 32 bytes of crypto randomness — keys look like `mppmcp_<hex>`.
    // Uses Web Crypto via the runtime adapter so this works in Node,
    // Workers, Edge, Deno, and Bun without modification.
    const key = `mppmcp_${randomHex(32)}`
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
        ...(boundTo && { boundTo }),
    }
}

/** Why a redemption was refused. */
export type RedeemFailureReason =
    /** No record for this token. */
    | 'unknown'
    /** The token authorizes a different tool. */
    | 'wrong-tool'
    /** The presenter's wallet doesn't match the record's `boundTo`. */
    | 'wrong-client'
    /**
     * The server requires wallet binding but this record carries no
     * binding, so there's no wallet to check the presenter against.
     * Honoring it would treat the token as a bearer credential.
     */
    | 'unbound-key'
    /** Past `expiresAt`. */
    | 'expired'
    /** `remainingCalls` hit zero. */
    | 'exhausted'

/** Outcome of attempting to redeem (use) an access key for a tool call. */
export type RedeemResult =
    | { ok: true; record: AccessKeyRecord }
    | { ok: false; reason: RedeemFailureReason }

/** Binding inputs for a redemption attempt. */
export interface RedeemOptions {
    /**
     * Wallet address presented by the requesting client, read from
     * `_meta[ACCESS_KEY_FINGERPRINT_META]`. Compared case-insensitively
     * against the record's `boundTo`.
     */
    clientFingerprint?: string
    /**
     * Set when the server runs with `accessKeyBinding: 'wallet'`. Makes
     * a present, matching `boundTo` mandatory: records without one are
     * refused with `'unbound-key'` rather than accepted as bearer
     * tokens. Without this flag an unbound record (minted before
     * binding was turned on, or by a peer instance running with binding
     * off against a shared store) would authorize any presenter.
     */
    requireBinding?: boolean
}

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
 *
 * @param options Binding inputs. See {@link RedeemOptions} — supply
 *   `requireBinding` whenever the server is configured with
 *   `accessKeyBinding: 'wallet'` so unbound records are refused
 *   instead of honored as bearer tokens.
 */
export async function redeem(
    store: MppMcpStore,
    key: string,
    toolName: string,
    options?: RedeemOptions
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

        // Fingerprint binding check: if the key was issued with a
        // `boundTo` address, only the original client may use it.
        // This prevents stolen keys from being replayed by a
        // different wallet.
        const declaresBinding =
            record.boundTo !== undefined && record.boundTo !== null && record.boundTo !== ''
        const boundTo = normalizeWalletAddress(record.boundTo)
        if (declaresBinding && boundTo === undefined) {
            // The record claims a binding we can't parse (corrupted or
            // schema-drifted store value). Refuse rather than fall back
            // to bearer semantics, which is what ignoring an
            // unparseable `boundTo` would amount to.
            outcome = { ok: false, reason: 'wrong-client' }
            return record // leave the record untouched
        }
        if (options?.requireBinding && boundTo === undefined) {
            // Server enforces wallet binding but this record has none,
            // so there is nothing to check the presenter against.
            outcome = { ok: false, reason: 'unbound-key' }
            return record // leave the record untouched
        }
        if (boundTo !== undefined) {
            const presented = normalizeWalletAddress(options?.clientFingerprint)
            if (presented === undefined || presented !== boundTo) {
                outcome = { ok: false, reason: 'wrong-client' }
                return record // leave the record untouched
            }
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
