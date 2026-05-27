/**
 * mpp-mcp-gateway — Cloudflare KV store
 *
 * Adapter mapping {@link MppMcpStore} onto a Cloudflare Workers KV
 * namespace. Suitable for edge deployments where Workers calls into KV
 * directly; the global distribution and zero connection-pool cost make
 * it attractive for low-latency access-key lookups.
 *
 * **Consistency caveat — read carefully before deploying.**
 *
 * Cloudflare KV is eventually consistent. A `put` may take up to ~60s
 * to propagate to all edge locations, and there is no native CAS or
 * transaction primitive. {@link MppMcpStore.update} on this adapter is
 * therefore **best-effort**: it reads, transforms, and writes, but it
 * does not block concurrent writers from other edge locations. Two
 * regions racing to redeem the same access key may both observe
 * `remainingCalls: 1` and both succeed, briefly issuing one extra free
 * call.
 *
 * Recommended uses:
 *   - **Access-key store** ✓ — the failure mode (a tiny over-issuance
 *     window) is acceptable for typical access-key workloads.
 *   - **Session-channel store** ✗ — the failure mode (mismatched
 *     vouchers across regions) breaks on-chain settlement. For session
 *     state on Cloudflare, use Durable Objects or call out to Upstash.
 *
 * The adapter logs a `console.warn` once per process when constructed,
 * and an additional warning when used as a session store, so operators
 * who skim documentation still get a clear signal at runtime.
 */

import { StoreError } from '../errors.js'
import type { Logger } from '../logger.js'
import { type MppMcpStore } from './types.js'

/**
 * Minimal subset of the Cloudflare Workers KV namespace API we depend
 * on. Defining it ourselves means the library compiles without a
 * `@cloudflare/workers-types` runtime dependency — users opt into that
 * type package only if they're actually deploying to Workers.
 */
export interface CloudflareKvLike {
    get(key: string, options?: { type?: 'text' | 'json' }): Promise<string | null>
    put(
        key: string,
        value: string,
        options?: { expirationTtl?: number }
    ): Promise<void>
    delete(key: string): Promise<void>
}

export interface CloudflareKvStoreOptions {
    /**
     * Namespace prefix applied to every key. Useful when sharing one
     * KV namespace across multiple gateways.
     *
     * @default '' (no prefix)
     */
    keyPrefix?: string

    /**
     * TTL applied to every write, in seconds. Cloudflare KV requires a
     * minimum of 60 seconds; values below that throw an error from the
     * KV API at write time.
     *
     * @default undefined (no TTL — keys persist until explicitly deleted)
     */
    ttlSeconds?: number

    /**
     * Suppress the consistency warning logged on construction. Off by
     * default — the warning is intentional. Set to `true` only if your
     * ops team has acknowledged the eventual-consistency tradeoff.
     *
     * @default false
     */
    suppressConsistencyWarning?: boolean

    /**
     * Optional logger. If supplied the construction warning fires
     * through it; otherwise it goes to `console.warn`. Useful when the
     * gateway has a configured logger and you want all output unified.
     */
    logger?: Logger
}

const CONSTRUCTOR_WARNING = `Cloudflare KV store constructed. ` +
    `KV is eventually consistent and update() is best-effort — concurrent ` +
    `writers across regions may produce small over-issuance windows. ` +
    `This is acceptable for access-key stores but unsafe for session ` +
    `vouchers. Pass suppressConsistencyWarning: true to silence this.`

/**
 * Build a Cloudflare-KV-backed {@link MppMcpStore}.
 */
export function createCloudflareKvStore(
    namespace: CloudflareKvLike,
    options: CloudflareKvStoreOptions = {}
): MppMcpStore {
    const prefix = options.keyPrefix ?? ''
    const ttl = options.ttlSeconds

    if (!options.suppressConsistencyWarning) {
        if (options.logger) {
            options.logger.warn(CONSTRUCTOR_WARNING, {
                component: 'stores.cloudflare-kv',
            })
        } else {
            // eslint-disable-next-line no-console
            console.warn(`[mpp-mcp-gateway] ${CONSTRUCTOR_WARNING}`)
        }
    }

    const fullKey = (k: string): string => `${prefix}${k}`

    return {
        async get<T>(key: string): Promise<T | null> {
            try {
                const raw = await namespace.get(fullKey(key))
                if (raw === null) return null
                return parseValue<T>(raw)
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Cloudflare KV get failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }
        },

        async put(key: string, value: unknown): Promise<void> {
            try {
                const serialized = JSON.stringify(value)
                await namespace.put(
                    fullKey(key),
                    serialized,
                    ttl !== undefined ? { expirationTtl: ttl } : undefined
                )
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Cloudflare KV put failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }
        },

        async delete(key: string): Promise<void> {
            try {
                await namespace.delete(fullKey(key))
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Cloudflare KV delete failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }
        },

        async update<T>(
            key: string,
            transform: (current: T | null) => T | null
        ): Promise<T | null> {
            // KV has no native CAS. We do the read-transform-write
            // sequence honestly and accept that concurrent writers from
            // different regions may interleave. Documented as
            // best-effort in the module-level docstring.
            const k = fullKey(key)

            let raw: string | null
            try {
                raw = await namespace.get(k)
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Cloudflare KV get (during update) failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }

            const current = raw === null ? null : parseValue<T>(raw)
            const result = transform(current)

            try {
                if (result === null) {
                    if (raw !== null) await namespace.delete(k)
                    return null
                }
                await namespace.put(
                    k,
                    JSON.stringify(result),
                    ttl !== undefined ? { expirationTtl: ttl } : undefined
                )
                return result
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Cloudflare KV write (during update) failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }
        },
    }
}

/**
 * Emit a one-shot warning when this store is wired as a session store.
 * Called from `server.ts` constructor — operators get an explicit
 * signal that the configuration is unsafe.
 *
 * Exported so it can be invoked from the server constructor without
 * coupling the server module to Cloudflare specifics.
 *
 * @experimental May become a runtime validation rather than a string
 * constant in a future minor version.
 */
export const CLOUDFLARE_KV_SESSION_WARNING = `Cloudflare KV is configured ` +
    `as the session store. KV's eventual consistency makes voucher state ` +
    `unsafe to share across edge regions: divergent vouchers will cause ` +
    `on-chain settlement to fail. Use Durable Objects, an Upstash-backed ` +
    `store, or run the gateway in a single region instead.`

function parseValue<T>(raw: string): T {
    try {
        return JSON.parse(raw) as T
    } catch (err) {
        throw new StoreError({
            kind: 'invalid-value',
            message: `Failed to parse KV value as JSON: ${errMessage(err)}`,
            cause: err,
        })
    }
}

function errMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
