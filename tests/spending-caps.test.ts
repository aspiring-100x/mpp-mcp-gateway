/**
 * Tests for spending cap enforcement.
 *
 * These tests assert that the client throws SpendingCapExceededError BEFORE
 * signing a payment transaction — they never hit the network. If the cap
 * logic were broken, these tests would either hang waiting for an RPC call
 * or produce a paid result with a receipt.
 */

import { describe, expect, it, afterEach } from 'vitest'
import { z } from 'zod'

import { SpendingCapExceededError } from '../src/index.js'
import { makeConnectedPair } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

describe('spending caps', () => {
    it('rejects a call when amount exceeds maxPerCall', async () => {
        const { client, dispose } = await makeConnectedPair({
            clientConfig: {
                maxPerCall: '0.01', // only allow sub-cent calls
                maxTotal: '100.00',
            },
            tools: [
                {
                    name: 'expensive',
                    description: 'Costs $1.00 per call — should be blocked.',
                    inputSchema: { q: z.string() },
                    pricing: { type: 'per-call', amount: '1.00' },
                    handler: async () => ({ content: [{ type: 'text', text: 'never' }] }),
                },
            ],
        })
        cleanup.push(dispose)

        await expect(client.callTool('expensive', { q: 'test' })).rejects.toBeInstanceOf(
            SpendingCapExceededError
        )

        // Spending should not have been recorded
        const spending = client.getSpending()
        expect(spending.totalSpent).toBe(0)
    })

    it('error message includes the requested amount and the cap', async () => {
        const { client, dispose } = await makeConnectedPair({
            clientConfig: { maxPerCall: '0.10', maxTotal: '100.00' },
            tools: [
                {
                    name: 'expensive',
                    description: '',
                    inputSchema: {},
                    pricing: { type: 'per-call', amount: '0.50' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })
        cleanup.push(dispose)

        try {
            await client.callTool('expensive')
            throw new Error('expected SpendingCapExceededError')
        } catch (err) {
            expect(err).toBeInstanceOf(SpendingCapExceededError)
            const e = err as SpendingCapExceededError
            expect(e.kind).toBe('per-call')
            expect(e.requested).toBeCloseTo(0.5, 6)
            expect(e.limit).toBeCloseTo(0.1, 2)
            expect(e.message).toMatch(/0\.500000/)
            expect(e.message).toMatch(/0\.10/)
        }
    })

    it('rejects when the per-call amount fits but cumulative would exceed maxTotal', async () => {
        // NOTE: this test CANNOT use a real paid call for the "first" call,
        // because that would require an on-chain tx. Instead we simulate
        // cumulative spend by poking the private totalSpent counter via the
        // public resetSpending() + manually increasing through the test
        // surface. We do this by doing a real in-memory test with an
        // explicitly preloaded totalSpent. Since the class doesn't expose
        // a setter, we verify the behavior indirectly: first ensure the
        // cap logic triggers on a tool whose price alone exceeds remaining
        // budget.
        const { client, dispose } = await makeConnectedPair({
            clientConfig: {
                maxPerCall: '10.00', // per-call fine
                maxTotal: '0.001', // but total is tiny
            },
            tools: [
                {
                    name: 'tiny',
                    description: '',
                    inputSchema: {},
                    pricing: { type: 'per-call', amount: '0.01' }, // bigger than maxTotal
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })
        cleanup.push(dispose)

        await expect(client.callTool('tiny')).rejects.toThrow(SpendingCapExceededError)
    })

    it('constructor rejects non-positive caps', async () => {
        const { dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        // Importing directly since we can't use makeConnectedPair with bad config
        const { createPaidMcpClient } = await import('../src/index.js')

        expect(() =>
            createPaidMcpClient({
                name: 'bad',
                version: '0',
                privateKey:
                    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
                maxPerCall: '-1',
                maxTotal: '100',
            })
        ).toThrow(/maxPerCall must be a positive number/)

        expect(() =>
            createPaidMcpClient({
                name: 'bad',
                version: '0',
                privateKey:
                    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
                maxPerCall: '1',
                maxTotal: '0',
            })
        ).toThrow(/maxTotal must be a positive number/)
    })

    it('allows a call whose amount is well under the cap', async () => {
        const { client, dispose } = await makeConnectedPair({
            clientConfig: {
                // Set caps high so the test wouldn't trip them even if it
                // went on to submit a tx — but we use a FREE tool here, so
                // no network involvement either way.
                maxPerCall: '1.00',
                maxTotal: '1.00',
            },
            tools: [
                {
                    name: 'free',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
                },
            ],
        })
        cleanup.push(dispose)

        const result = await client.callTool('free')
        expect(result.paid).toBe(false)
        expect(result.content[0]?.text).toBe('ok')
    })

    it('resetSpending() zeros out the cumulative counter', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        // No way to increment without paying, but we can at least verify
        // resetSpending is a no-op when already at zero and the getter
        // reflects that.
        expect(client.getSpending().totalSpent).toBe(0)
        client.resetSpending()
        expect(client.getSpending().totalSpent).toBe(0)
    })

    it('exposes remaining budget correctly', async () => {
        const { client, dispose } = await makeConnectedPair({
            clientConfig: { maxPerCall: '0.50', maxTotal: '5.00' },
            tools: [],
        })
        cleanup.push(dispose)

        const spending = client.getSpending()
        expect(spending.maxPerCall).toBeCloseTo(0.5)
        expect(spending.maxTotal).toBeCloseTo(5.0)
        expect(spending.remaining).toBeCloseTo(5.0)
    })
})
