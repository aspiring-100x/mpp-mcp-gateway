/**
 * mpp-mcp-gateway — rate limiting
 *
 * Pluggable rate limiter with three reference implementations:
 *
 *   - {@link tokenBucketLimiter} — in-process. Default. Token bucket
 *     per key with configurable rate and burst. Atomic within a
 *     single Node.js process by virtue of the event-loop's
 *     single-threaded execution.
 *   - {@link noopLimiter} — disables rate limiting entirely. Useful
 *     for tests and trusted environments.
 *   - {@link upstashTokenBucketLimiter} — Upstash Redis-backed.
 *     Multi-instance safe via a Lua-script CAS. Recommended for
 *     production deployments behind a load balancer.
 *
 * Why is this needed?
 *
 * Issuing a 402 challenge is computationally non-trivial: HMAC sign,
 * session-id allocation, stats update, call-log write. None of it
 * requires payment from the caller. Without rate limiting, an
 * attacker can flood `/mcp` with bogus tool calls and the gateway
 * does real work for free. Limiting at the 402 issuance layer caps
 * that.
 *
 * Where the limiter sits:
 *
 *   1. Shutdown gate (highest priority)
 *   2. **Rate limiter** ←
 *   3. In-flight counter increment
 *   4. Pricing / payment / handler logic
 *
 * Rate-limited calls never enter the in-flight counter, never touch
 * pricing, never run the user's handler. They abort early with
 * {@link RateLimitExceededError}.
 *
 * Atomicity:
 *
 *   - In-memory: synchronous within a single event-loop turn. Two
 *     concurrent `consume()` calls observe sequential reads and
 *     writes; JavaScript's single-threaded model guarantees no
 *     interleaving without an explicit `await`.
 *   - Upstash: atomic via Lua script. Refill computation, decrement,
 *     and write happen in a single round-trip.
 *
 * @module
 */

import { StoreError } from './errors.js'

/**
 * The result of a {@link RateLimiter.consume} call.
 *
 * On success, `allowed` is `true` and `remaining` reports the
 * remaining bucket budget (rounded down to whole tokens). On denial,
 * `allowed` is `false`, `remaining` is `0`, and `retryAfterMs`
 * carries the number of milliseconds the caller should wait before
 * retrying — computed from the bucket's refill rate.
 */
export type RateLimitResult =
    | { allowed: true; remaining: number }
    | { allowed: false; remaining: 0; retryAfterMs: number }

/**
 * The pluggable rate limiter interface. Any object implementing
 * `consume` works as a limiter; the optional `reset` method exists
 * for tests and admin tools.
 *
 * Implementations may be synchronous internally (in-memory) or
 * make network calls (Redis). The interface is async-friendly so
 * both shapes work without distinction at call sites.
 */
export interface RateLimiter {
    /**
     * Attempt to consume one unit of rate-limit budget for `key`.
     * Returns whether the operation is allowed and either the
     * remaining capacity or the suggested retry-after window.
     */
    consume(key: string): Promise<RateLimitResult>

    /**
     * Reset the bucket for `key` to its initial full capacity.
     * Optional — implementations that don't expose this throw on
     * call. Mainly for tests and admin reset endpoints.
     */
    reset?(key: string): Promise<void>
}

// -------------------------------------------------------------------
// In-memory token bucket
// -------------------------------------------------------------------

export interface TokenBucketOptions {
    /**
     * Sustained refill rate, in tokens per minute. The bucket adds
     * `refillPerMinute / 60` tokens per second up to `capacity`.
     *
     * @default 60 (1 token per second sustained)
     */
    refillPerMinute?: number

    /**
     * Maximum tokens the bucket holds. Determines burst capacity:
     * a freshly idle bucket can absorb `capacity` requests
     * instantaneously before throttling kicks in.
     *
     * @default equals refillPerMinute (1 minute of bursting)
     */
    capacity?: number
}

interface BucketState {
    tokens: number
    lastRefillMs: number
}

/**
 * Build an in-memory token-bucket rate limiter.
 *
 * State lives in a `Map` keyed by the operator-supplied bucket key.
 * Each `consume` call:
 *   1. Reads the current state (or initializes a full bucket).
 *   2. Computes refill based on elapsed wall-clock time.
 *   3. If the refilled bucket has at least 1 token, decrements and
 *      writes back. Otherwise computes `retryAfterMs`.
 *
 * Memory: each unique key allocates one `BucketState`. For high-
 * cardinality keys (e.g. per-IP across millions of clients) this
 * grows unbounded. Use the Upstash variant with TTL eviction for
 * those scenarios, or wrap this in a periodic-sweep adapter.
 *
 * @example
 * ```ts
 * const limiter = tokenBucketLimiter({
 *     refillPerMinute: 60,    // 1/sec sustained
 *     capacity: 10,            // up to 10-call burst
 * })
 * const result = await limiter.consume('my-tool')
 * if (!result.allowed) {
 *     console.log(`Retry after ${result.retryAfterMs}ms`)
 * }
 * ```
 */
export function tokenBucketLimiter(
    options: TokenBucketOptions = {}
): RateLimiter {
    const refillPerMinute = options.refillPerMinute ?? 60
    const capacity = options.capacity ?? refillPerMinute

    if (!(refillPerMinute > 0)) {
        throw new Error(
            `tokenBucketLimiter: refillPerMinute must be positive, got ${refillPerMinute}`
        )
    }
    if (!(capacity > 0)) {
        throw new Error(
            `tokenBucketLimiter: capacity must be positive, got ${capacity}`
        )
    }

    const refillPerMs = refillPerMinute / 60_000
    const buckets = new Map<string, BucketState>()

    return {
        async consume(key: string): Promise<RateLimitResult> {
            const now = Date.now()
            const existing = buckets.get(key)
            const state: BucketState = existing
                ? refill(existing, now, refillPerMs, capacity)
                : { tokens: capacity, lastRefillMs: now }

            if (state.tokens < 1) {
                const deficit = 1 - state.tokens
                const retryAfterMs = Math.ceil(deficit / refillPerMs)
                buckets.set(key, state)
                return { allowed: false, remaining: 0, retryAfterMs }
            }

            const next: BucketState = {
                tokens: state.tokens - 1,
                lastRefillMs: now,
            }
            buckets.set(key, next)
            return { allowed: true, remaining: Math.floor(next.tokens) }
        },

        async reset(key: string): Promise<void> {
            buckets.delete(key)
        },
    }
}

function refill(
    state: BucketState,
    now: number,
    refillPerMs: number,
    capacity: number
): BucketState {
    const elapsed = Math.max(0, now - state.lastRefillMs)
    const refilled = state.tokens + elapsed * refillPerMs
    return {
        tokens: Math.min(capacity, refilled),
        lastRefillMs: now,
    }
}

// -------------------------------------------------------------------
// No-op limiter
// -------------------------------------------------------------------

/**
 * A limiter that allows every request unconditionally. Useful for
 * tests and trusted environments where rate limiting would only
 * obscure load characteristics.
 */
export function noopLimiter(): RateLimiter {
    return {
        async consume(): Promise<RateLimitResult> {
            return { allowed: true, remaining: Number.POSITIVE_INFINITY }
        },
        async reset(): Promise<void> {
            /* no state to reset */
        },
    }
}

// -------------------------------------------------------------------
// Upstash Redis token bucket
// -------------------------------------------------------------------

export interface UpstashLimiterOptions extends TokenBucketOptions {
    /**
     * Optional namespace applied to every bucket key. Useful when
     * multiple gateways share a single Redis database.
     *
     * @default ''
     */
    keyPrefix?: string

    /**
     * TTL applied to each bucket entry, in seconds. Buckets that
     * haven't been touched in this window are evicted by Redis,
     * preventing unbounded memory growth from sparse keys.
     *
     * @default 3600 (1 hour)
     */
    ttlSeconds?: number
}

/**
 * Minimal subset of `@upstash/redis` we depend on. Same shape as
 * the store adapter so callers can reuse one Redis instance across
 * both the access-key store and the rate limiter.
 */
export interface UpstashRedisLike {
    eval(script: string, keys: string[], args: string[]): Promise<unknown>
    del(...keys: string[]): Promise<number>
}

/**
 * Atomic token-bucket Lua script.
 *
 * KEYS[1] = bucket key
 * ARGV[1] = capacity (max tokens)
 * ARGV[2] = refillPerMs (tokens added per millisecond)
 * ARGV[3] = nowMs (current time in ms; passed in so all instances
 *           share a clock when the Redis server's clock might
 *           differ)
 * ARGV[4] = ttlSeconds
 *
 * Returns:
 *   {1, remaining_floored}  on allow
 *   {0, retry_after_ms}     on deny
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local raw = redis.call('GET', key)
local tokens
local lastRefill

if raw == false then
    tokens = capacity
    lastRefill = now
else
    local sep = string.find(raw, ':')
    if sep == nil then
        tokens = capacity
        lastRefill = now
    else
        tokens = tonumber(string.sub(raw, 1, sep - 1))
        lastRefill = tonumber(string.sub(raw, sep + 1))
    end
end

local elapsed = now - lastRefill
if elapsed < 0 then elapsed = 0 end
local refilled = tokens + (elapsed * refillPerMs)
if refilled > capacity then refilled = capacity end

if refilled < 1 then
    redis.call('SET', key, tostring(refilled) .. ':' .. tostring(now), 'EX', ttl)
    local deficit = 1 - refilled
    local retryAfter = math.ceil(deficit / refillPerMs)
    return {0, retryAfter}
else
    local remaining = refilled - 1
    redis.call('SET', key, tostring(remaining) .. ':' .. tostring(now), 'EX', ttl)
    return {1, math.floor(remaining)}
end
`

/**
 * Build a multi-instance-safe rate limiter backed by Upstash Redis.
 *
 * State lives in Redis as `tokens:lastRefillMs` strings, one per
 * bucket key. The Lua script ensures refill computation and
 * decrement are atomic across all gateway instances sharing the
 * Redis database.
 *
 * @example
 * ```ts
 * import { Redis } from '@upstash/redis'
 * import { upstashTokenBucketLimiter } from 'mpp-mcp-gateway'
 *
 * const redis = new Redis({ url: ..., token: ... })
 * const limiter = upstashTokenBucketLimiter(redis, {
 *     keyPrefix: 'mppmcp:rl:',
 *     refillPerMinute: 600,
 *     capacity: 100,
 * })
 * ```
 */
export function upstashTokenBucketLimiter(
    client: UpstashRedisLike,
    options: UpstashLimiterOptions = {}
): RateLimiter {
    const refillPerMinute = options.refillPerMinute ?? 60
    const capacity = options.capacity ?? refillPerMinute
    const prefix = options.keyPrefix ?? ''
    const ttlSeconds = options.ttlSeconds ?? 3600

    if (!(refillPerMinute > 0)) {
        throw new Error(
            `upstashTokenBucketLimiter: refillPerMinute must be positive, got ${refillPerMinute}`
        )
    }
    if (!(capacity > 0)) {
        throw new Error(
            `upstashTokenBucketLimiter: capacity must be positive, got ${capacity}`
        )
    }

    const refillPerMs = refillPerMinute / 60_000
    const fullKey = (k: string): string => `${prefix}${k}`

    return {
        async consume(key: string): Promise<RateLimitResult> {
            let result: unknown
            try {
                result = await client.eval(
                    TOKEN_BUCKET_SCRIPT,
                    [fullKey(key)],
                    [
                        String(capacity),
                        String(refillPerMs),
                        String(Date.now()),
                        String(ttlSeconds),
                    ]
                )
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Upstash rate-limit eval failed for "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }

            if (!Array.isArray(result) || result.length !== 2) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Unexpected Upstash rate-limit response shape for "${key}".`,
                })
            }

            const [flag, second] = result as [number, number]
            if (flag === 1) {
                return { allowed: true, remaining: Number(second) }
            }
            return {
                allowed: false,
                remaining: 0,
                retryAfterMs: Number(second),
            }
        },

        async reset(key: string): Promise<void> {
            try {
                await client.del(fullKey(key))
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Upstash rate-limit reset failed for "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }
        },
    }
}

function errMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
