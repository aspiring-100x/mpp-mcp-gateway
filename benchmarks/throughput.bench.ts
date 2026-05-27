/**
 * mpp-mcp-gateway — throughput benchmarks
 *
 * Measures raw throughput of the gateway's hot-path components under
 * sustained load. Run with:
 *
 *   npx vitest bench benchmarks/
 *
 * These benchmarks exercise the library's internal paths WITHOUT network
 * I/O or on-chain interaction. They measure the overhead of the gateway
 * itself — pricing logic, stats tracking, store operations, rate limiting,
 * and call-log management.
 */

import { bench, describe } from 'vitest'
import { z } from 'zod'

import { createPaidMcpServer } from '../src/server.js'
import { createMemoryStore } from '../src/stores/memory.js'
import { tokenBucketLimiter, noopLimiter } from '../src/rate-limit.js'
import { silentLogger } from '../src/logger.js'
import { usdStringToBaseUnits, baseUnitsToUsdString } from '../src/amounts.js'
import { buildOpenApi } from '../src/discovery.js'
import { formatMetrics } from '../src/metrics.js'

// ─── Helpers ────────────────────────────────────────────────────────

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const SECRET = 'benchmark-secret-key-32-chars-xx'

function makeServer(opts: {
    pricing?: 'per-call' | 'free' | 'access-key'
    rateLimit?: boolean
    callLogSize?: number
}) {
    const pricing =
        opts.pricing === 'per-call'
            ? { type: 'per-call' as const, amount: '0.001' }
            : opts.pricing === 'access-key'
                ? { type: 'access-key' as const, amount: '0.01', maxCalls: 1000 }
                : undefined

    return createPaidMcpServer({
        name: 'bench',
        version: '1.0.0',
        recipient: RECIPIENT,
        secretKey: SECRET,
        logger: silentLogger(),
        callLogSize: opts.callLogSize ?? 1000,
        rateLimit: opts.rateLimit === false ? { enabled: false } : { limiter: noopLimiter() },
        tools: [
            {
                name: 'echo',
                description: 'Echo tool',
                inputSchema: { msg: z.string() },
                pricing,
                handler: async ({ msg }) => ({
                    content: [{ type: 'text' as const, text: String(msg) }],
                }),
            },
        ],
    })
}

// ─── Server stats + call log ────────────────────────────────────────

describe('server.getStats()', () => {
    const server = makeServer({ pricing: 'free', rateLimit: false })

    bench('getStats (cold)', () => {
        server.getStats()
    })
})

describe('server.getRecentCalls()', () => {
    const server = makeServer({ pricing: 'free', rateLimit: false, callLogSize: 1000 })
    // Populate the ring buffer
    for (let i = 0; i < 1000; i++) {
        // @ts-expect-error — accessing private method for benchmark setup
        server['appendCall']({
            tool: 'echo',
            timestamp: new Date().toISOString(),
            durationMs: 1,
            paid: false,
            paymentMode: 'free',
        })
    }

    bench('getRecentCalls(100) from full buffer', () => {
        server.getRecentCalls(100)
    })

    bench('getRecentCalls(1000) from full buffer', () => {
        server.getRecentCalls(1000)
    })
})

describe('ring buffer appendCall', () => {
    const server = makeServer({ pricing: 'free', rateLimit: false, callLogSize: 1000 })

    bench('appendCall (O(1) ring buffer write)', () => {
        // @ts-expect-error — accessing private method for benchmark
        server['appendCall']({
            tool: 'echo',
            timestamp: new Date().toISOString(),
            durationMs: 1,
            paid: false,
            paymentMode: 'free',
        })
    })
})

// ─── Amount math ────────────────────────────────────────────────────

describe('amount conversions (BigInt)', () => {
    bench('usdStringToBaseUnits("0.001", 6)', () => {
        usdStringToBaseUnits('0.001', 6)
    })

    bench('baseUnitsToUsdString(1000n, 6)', () => {
        baseUnitsToUsdString(1000n, 6)
    })

    bench('usdStringToBaseUnits("123.456789", 6)', () => {
        usdStringToBaseUnits('123.456789', 6)
    })

    bench('baseUnitsToUsdString(123456789n, 6)', () => {
        baseUnitsToUsdString(123456789n, 6)
    })
})

// ─── Rate limiter ───────────────────────────────────────────────────

describe('tokenBucketLimiter throughput', () => {
    const limiter = tokenBucketLimiter({ refillPerMinute: 600_000, capacity: 100_000 })

    bench('consume() — single key (allowed)', async () => {
        await limiter.consume('bench-tool')
    })
})

describe('tokenBucketLimiter — high cardinality', () => {
    const limiter = tokenBucketLimiter({ refillPerMinute: 60, capacity: 60 })
    let i = 0

    bench('consume() — unique key per call', async () => {
        await limiter.consume(`key-${i++}`)
    })
})

// ─── Memory store ───────────────────────────────────────────────────

describe('memory store operations', () => {
    const store = createMemoryStore()

    bench('put + get cycle', async () => {
        await store.put('bench-key', { count: 1 })
        await store.get('bench-key')
    })

    bench('update (atomic increment)', async () => {
        await store.update<{ count: number }>('counter', (c) => ({
            count: (c?.count ?? 0) + 1,
        }))
    })
})

describe('memory store — concurrent updates (contention)', () => {
    const store = createMemoryStore()

    bench('10 concurrent updates on same key', async () => {
        const promises = Array.from({ length: 10 }, () =>
            store.update<{ n: number }>('hot', (c) => ({ n: (c?.n ?? 0) + 1 }))
        )
        await Promise.all(promises)
    })
})

// ─── Discovery / OpenAPI build ──────────────────────────────────────

describe('buildOpenApi', () => {
    const server = createPaidMcpServer({
        name: 'bench-discovery',
        version: '1.0.0',
        recipient: RECIPIENT,
        secretKey: SECRET,
        logger: silentLogger(),
        rateLimit: { enabled: false },
        tools: Array.from({ length: 20 }, (_, i) => ({
            name: `tool_${i}`,
            description: `Tool number ${i}`,
            inputSchema: { input: z.string() },
            pricing: { type: 'per-call' as const, amount: '0.001' },
            handler: async () => ({ content: [{ type: 'text' as const, text: '' }] }),
        })),
    })

    bench('buildOpenApi (20 tools)', () => {
        buildOpenApi(server, { baseUrl: 'https://example.com', categories: ['data'] })
    })
})

// ─── Metrics formatting ─────────────────────────────────────────────

describe('formatMetrics', () => {
    const server = createPaidMcpServer({
        name: 'bench-metrics',
        version: '1.0.0',
        recipient: RECIPIENT,
        secretKey: SECRET,
        logger: silentLogger(),
        rateLimit: { enabled: false },
        tools: Array.from({ length: 10 }, (_, i) => ({
            name: `tool_${i}`,
            description: `Tool ${i}`,
            inputSchema: {},
            pricing: { type: 'per-call' as const, amount: '0.001' },
            handler: async () => ({ content: [{ type: 'text' as const, text: '' }] }),
        })),
    })

    bench('formatMetrics (10 tools)', () => {
        formatMetrics(server)
    })
})
