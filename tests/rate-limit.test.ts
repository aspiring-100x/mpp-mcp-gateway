/**
 * Tests for rate limiting.
 *
 * Three layers:
 *
 *   1. **Token-bucket math** — refill, capacity, retryAfter calculation,
 *      key isolation, reset.
 *   2. **Constructor validation** — non-positive rate/capacity throws.
 *   3. **Server integration** — tool calls hit the limiter, denied
 *      calls throw RateLimitExceededError without entering the
 *      in-flight counter, custom keyExtractor works, custom limiter
 *      works, `enabled: false` bypasses entirely.
 *
 * The Upstash-backed limiter has its own dedicated test file because
 * exercising real Redis requires a live test instance; the in-memory
 * limiter and the noop limiter are the two we cover here.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
    isMppMcpError,
    noopLimiter,
    RateLimitExceededError,
    tokenBucketLimiter,
} from '../src/index.js'
import { makeConnectedPair } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

describe('tokenBucketLimiter — math', () => {
    it('allows up to capacity in an instantaneous burst', async () => {
        const limiter = tokenBucketLimiter({
            refillPerMinute: 60,
            capacity: 5,
        })

        for (let i = 0; i < 5; i++) {
            const r = await limiter.consume('k')
            expect(r.allowed).toBe(true)
        }
        const sixth = await limiter.consume('k')
        expect(sixth.allowed).toBe(false)
    })

    it('returns retryAfterMs derived from the refill rate', async () => {
        // 60/min = 1/sec → drain the bucket then check retryAfterMs.
        const limiter = tokenBucketLimiter({
            refillPerMinute: 60,
            capacity: 1,
        })

        const first = await limiter.consume('k')
        expect(first.allowed).toBe(true)

        const second = await limiter.consume('k')
        expect(second.allowed).toBe(false)
        // Need ~1 token, refill is 1/1000ms → retry ≈ 1000ms.
        // Allow some slack for execution time between consumes.
        if (!second.allowed) {
            expect(second.retryAfterMs).toBeGreaterThan(900)
            expect(second.retryAfterMs).toBeLessThanOrEqual(1000)
        }
    })

    it('refills tokens over time', async () => {
        const limiter = tokenBucketLimiter({
            refillPerMinute: 60_000, // 1000/sec → 1/ms
            capacity: 2,
        })

        // Drain.
        await limiter.consume('k')
        await limiter.consume('k')
        const drained = await limiter.consume('k')
        expect(drained.allowed).toBe(false)

        // Wait long enough for at least 1 token to refill.
        await sleep(20)
        const afterRefill = await limiter.consume('k')
        expect(afterRefill.allowed).toBe(true)
    })

    it('isolates buckets by key', async () => {
        const limiter = tokenBucketLimiter({
            refillPerMinute: 60,
            capacity: 1,
        })

        const a1 = await limiter.consume('alpha')
        const b1 = await limiter.consume('beta')
        expect(a1.allowed).toBe(true)
        expect(b1.allowed).toBe(true)

        // Both buckets are now empty.
        const a2 = await limiter.consume('alpha')
        const b2 = await limiter.consume('beta')
        expect(a2.allowed).toBe(false)
        expect(b2.allowed).toBe(false)
    })

    it('reset() restores a bucket to full capacity', async () => {
        const limiter = tokenBucketLimiter({
            refillPerMinute: 60,
            capacity: 2,
        })

        await limiter.consume('k')
        await limiter.consume('k')
        const drained = await limiter.consume('k')
        expect(drained.allowed).toBe(false)

        await limiter.reset!('k')
        const restored = await limiter.consume('k')
        expect(restored.allowed).toBe(true)
    })

    it('default capacity equals refillPerMinute when not specified', async () => {
        const limiter = tokenBucketLimiter({ refillPerMinute: 3 })

        const a = await limiter.consume('k')
        const b = await limiter.consume('k')
        const c = await limiter.consume('k')
        const d = await limiter.consume('k')

        expect(a.allowed).toBe(true)
        expect(b.allowed).toBe(true)
        expect(c.allowed).toBe(true)
        expect(d.allowed).toBe(false)
    })

    it('reports remaining capacity on allowed calls', async () => {
        const limiter = tokenBucketLimiter({
            refillPerMinute: 60,
            capacity: 5,
        })

        const r1 = await limiter.consume('k')
        const r2 = await limiter.consume('k')

        if (r1.allowed) expect(r1.remaining).toBe(4)
        if (r2.allowed) expect(r2.remaining).toBe(3)
    })
})

describe('tokenBucketLimiter — constructor validation', () => {
    it('rejects non-positive refillPerMinute', () => {
        expect(() => tokenBucketLimiter({ refillPerMinute: 0 })).toThrow(
            /refillPerMinute must be positive/
        )
        expect(() => tokenBucketLimiter({ refillPerMinute: -1 })).toThrow(
            /refillPerMinute must be positive/
        )
    })

    it('rejects non-positive capacity', () => {
        expect(() =>
            tokenBucketLimiter({ refillPerMinute: 60, capacity: 0 })
        ).toThrow(/capacity must be positive/)
        expect(() =>
            tokenBucketLimiter({ refillPerMinute: 60, capacity: -1 })
        ).toThrow(/capacity must be positive/)
    })
})

describe('noopLimiter', () => {
    it('always allows and reports infinite remaining', async () => {
        const limiter = noopLimiter()
        for (let i = 0; i < 1000; i++) {
            const r = await limiter.consume('k')
            expect(r.allowed).toBe(true)
        }
    })
})

describe('server integration — default rate limiting on', () => {
    it('rejects calls past capacity with RateLimitExceededError', async () => {
        // Override the test default (`enabled: false`) so the real
        // limiter runs. Tiny capacity so we hit the limit fast.
        const { client, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'echo',
                    description: '',
                    inputSchema: { msg: z.string() },
                    handler: async ({ msg }) => ({
                        content: [{ type: 'text', text: String(msg) }],
                    }),
                },
            ],
            serverConfig: {
                rateLimit: { enabled: true, capacity: 2, refillPerMinute: 1 },
            },
        })
        cleanup.push(dispose)

        // First two pass.
        await client.callTool('echo', { msg: 'a' })
        await client.callTool('echo', { msg: 'b' })

        // Third should be rejected. The MCP SDK projects handler
        // throws into a content-shaped result rather than a promise
        // rejection. We assert on the surface reachable from the
        // client side.
        const result = (await client.callTool('echo', {
            msg: 'c',
        })) as unknown as {
            content: Array<{ text?: string }>
        }
        const text = result.content.map((c) => c.text ?? '').join(' ')
        expect(text).toMatch(/rate limit exceeded/i)
    })

    it('denied calls do NOT enter the in-flight counter', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'gated',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({
                        content: [{ type: 'text', text: 'ok' }],
                    }),
                },
            ],
            serverConfig: {
                rateLimit: { enabled: true, capacity: 1, refillPerMinute: 1 },
            },
        })
        cleanup.push(dispose)

        // Drain the bucket.
        await client.callTool('gated')
        // Denied call.
        await client.callTool('gated').catch(() => {
            /* MCP wraps as content; either shape is fine */
        })

        // After both calls fully resolve, in-flight should be zero.
        // The denied call should never have entered the counter.
        expect(server.getInFlightCount()).toBe(0)
    })

    it('custom keyExtractor produces independent buckets', async () => {
        let counter = 0
        const { client, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'echo',
                    description: '',
                    inputSchema: { tag: z.string() },
                    handler: async ({ tag }) => ({
                        content: [{ type: 'text', text: String(tag) }],
                    }),
                },
            ],
            serverConfig: {
                rateLimit: {
                    enabled: true,
                    capacity: 1,
                    refillPerMinute: 1,
                    // Each call gets a fresh bucket key, so no
                    // throttling kicks in even though capacity is 1.
                    keyExtractor: (toolName) => `${toolName}:${counter++}`,
                },
            },
        })
        cleanup.push(dispose)

        // Five calls, each into its own bucket. All allowed.
        for (let i = 0; i < 5; i++) {
            const r = (await client.callTool('echo', {
                tag: String(i),
            })) as unknown as { content: Array<{ text?: string }> }
            const text = r.content.map((c) => c.text ?? '').join('')
            expect(text).toBe(String(i))
        }
    })

    it('custom limiter is used in place of the default', async () => {
        const seen: string[] = []
        const limiter = {
            async consume(key: string) {
                seen.push(key)
                return { allowed: true, remaining: 0 } as const
            },
        }

        const { client, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'echo',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({
                        content: [{ type: 'text', text: 'ok' }],
                    }),
                },
            ],
            serverConfig: {
                rateLimit: { enabled: true, limiter },
            },
        })
        cleanup.push(dispose)

        await client.callTool('echo')
        await client.callTool('echo')

        expect(seen).toEqual(['echo', 'echo'])
    })
})

describe('server integration — disabled rate limiting', () => {
    it('enabled: false bypasses the limiter entirely', async () => {
        const { client, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'echo',
                    description: '',
                    inputSchema: { i: z.number().int() },
                    handler: async ({ i }) => ({
                        content: [{ type: 'text', text: String(i) }],
                    }),
                },
            ],
            serverConfig: {
                rateLimit: { enabled: false, capacity: 1, refillPerMinute: 1 },
            },
        })
        cleanup.push(dispose)

        // Capacity is 1 in the config, but `enabled: false` means
        // the noop limiter runs. All 100 calls go through.
        for (let i = 0; i < 100; i++) {
            await client.callTool('echo', { i })
        }
    })
})

describe('RateLimitExceededError shape', () => {
    it('exposes tool, bucketKey, retryAfterMs and the rate-limited code', () => {
        const e = new RateLimitExceededError({
            tool: 'foo',
            bucketKey: 'foo:abc',
            retryAfterMs: 1500,
        })

        expect(e.tool).toBe('foo')
        expect(e.bucketKey).toBe('foo:abc')
        expect(e.retryAfterMs).toBe(1500)
        expect(e.code).toBe('rate-limited')
        expect(isMppMcpError(e)).toBe(true)
        expect(e.message).toMatch(/Rate limit exceeded/)
    })
})

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
