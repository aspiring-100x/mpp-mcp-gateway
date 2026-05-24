/**
 * mpp-mcp-gateway — Upstash Redis store
 *
 * Adapter mapping {@link MppMcpStore} onto the
 * [`@upstash/redis`](https://github.com/upstash/upstash-redis) HTTP
 * client. Recommended for production deployments — works across
 * instances, supports edge runtimes (Vercel, Lambda, Workers), and
 * provides true atomic CAS via Redis `WATCH`/`MULTI`/`EXEC`.
 *
 * Atomicity guarantee:
 *   - {@link MppMcpStore.update} uses optimistic concurrency control.
 *     If another writer modifies the key between our read and write,
 *     the transaction aborts and we retry with the freshly observed
 *     value. After {@link UpstashStoreOptions.maxAttempts} unsuccessful
 *     attempts (default 8), throws a {@link StoreError} with
 *     `kind: 'cas-exhausted'`.
 *
 * The `transform` callback may be invoked more than once on contention —
 * see {@link MppMcpStore.update} for the contract.
 *
 * @example
 * ```ts
 * import { Redis } from '@upstash/redis'
 * import { createUpstashStore } from 'mpp-mcp-gateway/stores'
 *
 * const redis = new Redis({
 *     url: process.env.UPSTASH_REDIS_REST_URL!,
 *     token: process.env.UPSTASH_REDIS_REST_TOKEN!,
 * })
 *
 * const store = createUpstashStore(redis, {
 *     keyPrefix: 'mppmcp:keys:',
 *     ttlSeconds: 30 * 24 * 60 * 60, // 30d
 * })
 * ```
 */

import { StoreError, type MppMcpStore } from './types.js'

/**
 * Minimal subset of the `@upstash/redis` client surface we depend on.
 * Defining it ourselves means consumers can pass any compatible client
 * (e.g. an `ioredis` shim, a test double) without us locking the type
 * to a specific upstash-redis version.
 */
export interface UpstashRedisLike {
    get<T = string>(key: string): Promise<T | null>
    set(
        key: string,
        value: string,
        opts?: { ex?: number; nx?: boolean; xx?: boolean }
    ): Promise<unknown>
    del(...keys: string[]): Promise<number>
    /**
     * Execute a Lua script. Upstash's `eval` returns the script's
     * result; we parse it ourselves into the shape we need.
     */
    eval(script: string, keys: string[], args: string[]): Promise<unknown>
}

export interface UpstashStoreOptions {
    /**
     * Optional namespace applied to every key. Useful when multiple
     * gateways share a single Redis database.
     *
     * @default '' (no prefix)
     */
    keyPrefix?: string

    /**
     * Default TTL applied to every `put`/`update` write, in seconds.
     * Records older than this are evicted by Redis automatically.
     *
     * Recommended for access-key records: set this to slightly longer
     * than your maximum `validFor` so expired keys are cleaned up
     * server-side without manual sweeps.
     *
     * @default undefined (no TTL — keys persist indefinitely)
     */
    ttlSeconds?: number

    /**
     * Maximum number of CAS retries before {@link MppMcpStore.update}
     * gives up and throws `StoreError(kind: 'cas-exhausted')`.
     *
     * @default 8
     */
    maxAttempts?: number
}

/**
 * The Lua script for atomic update. Reads the current value, hands it
 * back to JS so our transform can run, then re-issues a write with a
 * `WATCH`-equivalent guard. Upstash's REST API doesn't support
 * multi-statement transactions, so we implement CAS at the Lua level:
 * the script atomically (a) reads the current value and (b) performs a
 * conditional write only if the caller's expected `prev` matches.
 *
 * KEYS[1] = the storage key
 * ARGV[1] = expected previous value (JSON string, or empty for "must not exist")
 * ARGV[2] = expected-must-exist flag ('1' if ARGV[1] is meaningful, '0' if "must not exist")
 * ARGV[3] = new value (JSON string, or empty for delete)
 * ARGV[4] = delete flag ('1' if we should delete, '0' if write)
 * ARGV[5] = TTL in seconds (0 for none, only meaningful on write)
 *
 * Returns:
 *   {1, current_value} on success — current_value reflects the post-write state
 *   {0, current_value} on conflict — current_value is the actual current state
 *   {0, false} when the conflict was "key existed but caller expected absence" or vice versa
 */
const ATOMIC_UPDATE_SCRIPT = `
local key = KEYS[1]
local expectedPrev = ARGV[1]
local expectedExists = ARGV[2]
local newValue = ARGV[3]
local doDelete = ARGV[4]
local ttl = tonumber(ARGV[5])

local current = redis.call('GET', key)

-- Verify the precondition.
if expectedExists == '1' then
    if current == false then
        return {0, false}
    end
    if current ~= expectedPrev then
        return {0, current}
    end
else
    if current ~= false then
        return {0, current}
    end
end

-- Apply the change.
if doDelete == '1' then
    redis.call('DEL', key)
    return {1, false}
else
    if ttl > 0 then
        redis.call('SET', key, newValue, 'EX', ttl)
    else
        redis.call('SET', key, newValue)
    end
    return {1, newValue}
end
`

/**
 * Build an Upstash-Redis-backed {@link MppMcpStore}.
 */
export function createUpstashStore(
    client: UpstashRedisLike,
    options: UpstashStoreOptions = {}
): MppMcpStore {
    const prefix = options.keyPrefix ?? ''
    const ttl = options.ttlSeconds
    const maxAttempts = options.maxAttempts ?? 8

    const fullKey = (k: string): string => `${prefix}${k}`

    return {
        async get<T>(key: string): Promise<T | null> {
            try {
                const raw = await client.get<string>(fullKey(key))
                if (raw === null || raw === undefined) return null
                return parseValue<T>(raw)
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Upstash GET failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }
        },

        async put(key: string, value: unknown): Promise<void> {
            try {
                const serialized = JSON.stringify(value)
                const opts =
                    ttl !== undefined ? { ex: ttl } : undefined
                await client.set(fullKey(key), serialized, opts)
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Upstash SET failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }
        },

        async delete(key: string): Promise<void> {
            try {
                await client.del(fullKey(key))
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Upstash DEL failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }
        },

        async update<T>(
            key: string,
            transform: (current: T | null) => T | null
        ): Promise<T | null> {
            const k = fullKey(key)

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                let observed: string | null
                try {
                    const raw = await client.get<string>(k)
                    observed = raw === undefined ? null : raw
                } catch (err) {
                    throw new StoreError({
                        kind: 'backend-error',
                        message: `Upstash GET (during update) failed for key "${key}": ${errMessage(err)}`,
                        cause: err,
                    })
                }

                const currentValue =
                    observed === null ? null : parseValue<T>(observed)
                const result = transform(currentValue)

                const expectedExists = observed !== null
                const newSerialized = result === null ? '' : JSON.stringify(result)

                let scriptResult: unknown
                try {
                    scriptResult = await client.eval(
                        ATOMIC_UPDATE_SCRIPT,
                        [k],
                        [
                            observed ?? '',
                            expectedExists ? '1' : '0',
                            newSerialized,
                            result === null ? '1' : '0',
                            String(ttl ?? 0),
                        ]
                    )
                } catch (err) {
                    throw new StoreError({
                        kind: 'backend-error',
                        message: `Upstash EVAL (during update) failed for key "${key}": ${errMessage(err)}`,
                        cause: err,
                    })
                }

                if (!Array.isArray(scriptResult) || scriptResult.length !== 2) {
                    throw new StoreError({
                        kind: 'backend-error',
                        message: `Unexpected Upstash EVAL response shape for key "${key}".`,
                    })
                }

                const [okFlag] = scriptResult as [number, unknown]
                if (okFlag === 1) {
                    return result
                }
                // Conflict: another writer updated between our GET and EVAL.
                // Loop and retry.
            }

            throw new StoreError({
                kind: 'cas-exhausted',
                message: `Atomic update of key "${key}" failed after ${maxAttempts} attempts due to concurrent writers.`,
            })
        },
    }
}

function parseValue<T>(raw: string): T {
    try {
        return JSON.parse(raw) as T
    } catch (err) {
        throw new StoreError({
            kind: 'invalid-value',
            message: `Failed to parse stored value as JSON: ${errMessage(err)}`,
            cause: err,
        })
    }
}

function errMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
