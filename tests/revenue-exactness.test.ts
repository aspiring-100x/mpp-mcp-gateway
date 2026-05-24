/**
 * Tests for exact revenue tracking under high call counts.
 *
 * These tests bypass the network entirely — they invoke the server's
 * private `recordPaidCall` helper directly (same pattern used in
 * `dashboard.test.ts` for `appendCall`). The goal is to prove that
 * cumulative revenue stays exact across thousands of additions.
 *
 * Before the BigInt-based ledger landed, these assertions failed with
 * floating-point drift — `parseFloat('0.001') + parseFloat('0.001') ...`
 * accumulates trailing-digit error after a few hundred additions and
 * `toFixed(6)` rounding doesn't fully hide it because the round error
 * compounds.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createPaidMcpServer } from '../src/server.js'
import type { PaidMcpServer } from '../src/server.js'

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const SECRET = 'revenue-exactness-test-secret'

/** Cast the server to expose its private `recordPaidCall` for direct invocation. */
function asInternal(server: PaidMcpServer): {
    recordPaidCall: (toolName: string, amount: string, isSession?: boolean) => void
} {
    return server as unknown as {
        recordPaidCall: (toolName: string, amount: string, isSession?: boolean) => void
    }
}

function buildServer() {
    return createPaidMcpServer({
        name: 'revenue-test',
        version: '0.0.0',
        recipient: RECIPIENT,
        secretKey: SECRET,
        tools: [
            {
                name: 'paid_a',
                description: '',
                inputSchema: { x: z.string() },
                pricing: { type: 'per-call', amount: '0.001' },
                handler: async () => ({ content: [{ type: 'text', text: '' }] }),
            },
            {
                name: 'paid_b',
                description: '',
                inputSchema: { x: z.string() },
                pricing: { type: 'per-call', amount: '0.0001' },
                handler: async () => ({ content: [{ type: 'text', text: '' }] }),
            },
        ],
    })
}

describe('revenue exactness', () => {
    it('totals exactly $10.000000 after 10,000 calls of $0.001 each', () => {
        const server = buildServer()
        const internal = asInternal(server)

        for (let i = 0; i < 10_000; i++) {
            internal.recordPaidCall('paid_a', '0.001')
        }

        const stats = server.getStats()
        // Exact string match — no drift, no rounding artifacts.
        expect(stats.totalRevenue).toBe('10.000000')
        expect(stats.revenueByTool['paid_a']).toBe('10.000000')
        expect(stats.callsByTool['paid_a']).toBe(10_000)
        expect(stats.paidCalls).toBe(10_000)
    })

    it('handles mixed amounts across tools without cross-tool drift', () => {
        const server = buildServer()
        const internal = asInternal(server)

        // 1,000 calls of $0.001 to paid_a and 1,000 calls of $0.0001 to paid_b.
        // Expected totals: paid_a = $1.000000, paid_b = $0.100000, grand = $1.100000
        for (let i = 0; i < 1000; i++) {
            internal.recordPaidCall('paid_a', '0.001')
            internal.recordPaidCall('paid_b', '0.0001')
        }

        const stats = server.getStats()
        expect(stats.revenueByTool['paid_a']).toBe('1.000000')
        expect(stats.revenueByTool['paid_b']).toBe('0.100000')
        expect(stats.totalRevenue).toBe('1.100000')
        expect(stats.callsByTool['paid_a']).toBe(1000)
        expect(stats.callsByTool['paid_b']).toBe(1000)
    })

    it('treats a sub-cent amount that floats would round as exact', () => {
        // 0.1 + 0.2 in float is 0.30000000000000004.
        // We exercise the equivalent path through the revenue ledger:
        // three additions whose float sum would be 0.300000000000004 but
        // whose BigInt sum is exactly 300000 base units = '0.300000'.
        const server = buildServer()
        const internal = asInternal(server)

        internal.recordPaidCall('paid_a', '0.1')
        internal.recordPaidCall('paid_a', '0.2')

        const stats = server.getStats()
        expect(stats.totalRevenue).toBe('0.300000')
        expect(stats.revenueByTool['paid_a']).toBe('0.300000')
    })

    it('starts at "0" before any paid calls', () => {
        const server = buildServer()
        const stats = server.getStats()
        expect(stats.totalRevenue).toBe('0')
        expect(stats.revenueByTool).toEqual({})
    })

    it('flags isSession in stats but accumulates the same way', () => {
        const server = buildServer()
        const internal = asInternal(server)

        internal.recordPaidCall('paid_a', '0.001', true)
        internal.recordPaidCall('paid_a', '0.001', true)
        internal.recordPaidCall('paid_a', '0.001', false)

        const stats = server.getStats()
        expect(stats.totalRevenue).toBe('0.003000')
        expect(stats.sessionCalls).toBe(2)
        expect(stats.paidCalls).toBe(3)
    })
})
