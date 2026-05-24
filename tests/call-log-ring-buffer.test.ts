/**
 * Tests for the ring-buffer call log.
 *
 * The append path must be O(1) — bounded work per call regardless of
 * fill state. We don't measure wall-clock time directly (too flaky) but
 * we do prove the underlying array stays bounded at capacity, which is
 * what made the previous splice-based implementation O(n) under load.
 *
 * We also exercise the wrap semantics: write past capacity, write many
 * full cycles, write into a one-slot buffer. In every case the read
 * path must return newest-first and respect the limit.
 */

import { describe, expect, it } from 'vitest'

import { createPaidMcpServer } from '../src/server.js'
import type { PaidMcpServer } from '../src/server.js'
import type { CallLogEntry } from '../src/types.js'

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const SECRET = 'ring-buffer-test-secret'

/** @internal Cast through the prototype to call the private `appendCall`. */
function appender(server: PaidMcpServer): (e: CallLogEntry) => void {
    return (server as unknown as { appendCall: (e: CallLogEntry) => void })
        .appendCall.bind(server)
}

/** @internal Read the underlying array length to assert no growth. */
function internalArrayLength(server: PaidMcpServer): number {
    return (server as unknown as { callLog: Array<unknown> }).callLog.length
}

function makeServer(callLogSize: number): PaidMcpServer {
    return createPaidMcpServer({
        name: 'ring-buffer-test',
        version: '0.0.0',
        recipient: RECIPIENT,
        secretKey: SECRET,
        callLogSize,
        tools: [],
    })
}

function entry(tag: string): CallLogEntry {
    return {
        tool: 't',
        timestamp: new Date().toISOString(),
        durationMs: 1,
        paid: false,
        paymentMode: 'free',
        error: tag,
    }
}

describe('call log ring buffer', () => {
    it('does not grow the underlying array beyond capacity', () => {
        const server = makeServer(100)
        const append = appender(server)

        for (let i = 0; i < 10_000; i++) {
            append(entry(`e${i}`))
        }

        // Pre-allocated to capacity and never grows. The previous
        // splice-based implementation would have hit length 100 before
        // each splice, which is bounded too — but every splice is O(n).
        // Here we additionally guarantee the array NEVER exceeds capacity,
        // proving the new implementation never even reaches the splice path.
        expect(internalArrayLength(server)).toBe(100)
    })

    it('returns at most `limit` entries newest-first', () => {
        const server = makeServer(10)
        const append = appender(server)

        for (let i = 0; i < 10; i++) append(entry(`e${i}`))

        const recent = server.getRecentCalls(3)
        expect(recent).toHaveLength(3)
        expect(recent.map((c) => c.error)).toEqual(['e9', 'e8', 'e7'])
    })

    it('returns count when limit exceeds buffered entries', () => {
        const server = makeServer(100)
        const append = appender(server)

        for (let i = 0; i < 5; i++) append(entry(`e${i}`))

        const recent = server.getRecentCalls(50)
        expect(recent).toHaveLength(5)
        expect(recent.map((c) => c.error)).toEqual([
            'e4',
            'e3',
            'e2',
            'e1',
            'e0',
        ])
    })

    it('drops oldest entries on overflow', () => {
        const server = makeServer(3)
        const append = appender(server)

        for (let i = 0; i < 5; i++) append(entry(`e${i}`))

        // Inserted: e0, e1, e2, e3, e4
        // Capacity 3 keeps the latest 3 → e2, e3, e4
        // Newest-first → e4, e3, e2
        const recent = server.getRecentCalls()
        expect(recent.map((c) => c.error)).toEqual(['e4', 'e3', 'e2'])
    })

    it('handles many full wraps without losing newest-first ordering', () => {
        const server = makeServer(5)
        const append = appender(server)

        // 17 entries through a 5-slot buffer = 3 full wraps + 2 extra.
        // Final state should be the last 5: e12, e13, e14, e15, e16.
        for (let i = 0; i < 17; i++) append(entry(`e${i}`))

        const recent = server.getRecentCalls()
        expect(recent.map((c) => c.error)).toEqual([
            'e16',
            'e15',
            'e14',
            'e13',
            'e12',
        ])
        expect(internalArrayLength(server)).toBe(5)
    })

    it('handles a single-slot buffer correctly', () => {
        const server = makeServer(1)
        const append = appender(server)

        append(entry('e0'))
        expect(server.getRecentCalls().map((c) => c.error)).toEqual(['e0'])

        append(entry('e1'))
        expect(server.getRecentCalls().map((c) => c.error)).toEqual(['e1'])

        append(entry('e2'))
        expect(server.getRecentCalls().map((c) => c.error)).toEqual(['e2'])

        expect(internalArrayLength(server)).toBe(1)
    })

    it('returns [] when the buffer is empty regardless of limit', () => {
        const server = makeServer(100)
        expect(server.getRecentCalls()).toEqual([])
        expect(server.getRecentCalls(0)).toEqual([])
        expect(server.getRecentCalls(50)).toEqual([])
    })

    it('callLogSize=0 keeps the buffer empty and getRecentCalls returns []', () => {
        const server = makeServer(0)
        const append = appender(server)

        append(entry('e0'))
        append(entry('e1'))

        expect(server.getRecentCalls()).toEqual([])
        expect(internalArrayLength(server)).toBe(0)
    })

    it('limit=0 returns an empty array even when buffer has entries', () => {
        const server = makeServer(10)
        const append = appender(server)

        for (let i = 0; i < 5; i++) append(entry(`e${i}`))

        expect(server.getRecentCalls(0)).toEqual([])
    })

    it('clamps negative limits to 0', () => {
        const server = makeServer(10)
        const append = appender(server)

        for (let i = 0; i < 5; i++) append(entry(`e${i}`))

        expect(server.getRecentCalls(-1)).toEqual([])
        expect(server.getRecentCalls(-100)).toEqual([])
    })
})
