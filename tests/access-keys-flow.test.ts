/**
 * End-to-end access-key integration test.
 *
 * Pays once via a real Tempo testnet `tempo.charge`, captures the issued
 * access key, and exercises the cached-key path for two additional calls
 * — those should NOT incur further on-chain charges.
 *
 * Gated by RUN_INTEGRATION the same way the other integration tests are.
 *
 * Expected runtime: ~2-3s (one block for the upfront charge, then two
 * cache-hit calls finish locally).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { makeConnectedPair } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

const RUN_INTEGRATION = process.env.RUN_INTEGRATION !== 'false'
const maybeIt = RUN_INTEGRATION ? it : it.skip

describe('access-key flow (integration — hits Tempo testnet)', () => {
    maybeIt(
        'pays once, then serves 2 follow-up calls free against the cached key',
        async () => {
            const { client, server, dispose } = await makeConnectedPair({
                clientConfig: { maxPerCall: '1.00', maxTotal: '1.00' },
                tools: [
                    {
                        name: 'gated_echo',
                        description: 'Costs $0.001 upfront for 5 calls.',
                        inputSchema: { msg: z.string() },
                        pricing: {
                            type: 'access-key',
                            amount: '0.001',
                            maxCalls: 5,
                        },
                        handler: async ({ msg }) => ({
                            content: [
                                { type: 'text', text: `gated: ${String(msg)}` },
                            ],
                        }),
                    },
                ],
            })
            cleanup.push(dispose)

            // First call pays $0.001 and mints the key.
            const r1 = await client.callTool('gated_echo', { msg: 'first' })
            expect(r1.paid).toBe(true)
            expect(r1.receipt).toBeDefined()
            expect(r1.receipt!.method).toBe('tempo')
            expect(r1.accessKey).toBeDefined()
            expect(r1.accessKey!.justIssued).toBe(true)
            expect(r1.accessKey!.remainingCalls).toBe(4)
            expect(r1.content[0]?.text).toBe('gated: first')

            // The client should now have a cached entry.
            const cached = client.getAccessKeys()
            expect(cached['gated_echo']).toBeDefined()
            expect(cached['gated_echo']!.key).toBe(r1.accessKey!.key)

            // Second call — free, decrements remainingCalls.
            const r2 = await client.callTool('gated_echo', { msg: 'second' })
            expect(r2.paid).toBe(false)
            expect(r2.receipt).toBeUndefined()
            expect(r2.accessKey).toBeDefined()
            expect(r2.accessKey!.justIssued).toBe(false)
            expect(r2.accessKey!.remainingCalls).toBe(3)
            expect(r2.content[0]?.text).toBe('gated: second')

            // Third call — also free.
            const r3 = await client.callTool('gated_echo', { msg: 'third' })
            expect(r3.paid).toBe(false)
            expect(r3.accessKey!.remainingCalls).toBe(2)

            // Server stats: 1 paid call, 2 access-key calls, 1 issuance, no expirations.
            const stats = server.getStats()
            expect(stats.totalCalls).toBe(3)
            expect(stats.paidCalls).toBe(1)
            expect(stats.accessKeyCalls).toBe(2)
            expect(stats.accessKeysIssued).toBe(1)
            expect(stats.accessKeysExpired).toBe(0)
            expect(parseFloat(stats.totalRevenue)).toBeCloseTo(0.001, 6)

            // Client only spent the upfront $0.001, not 3x.
            expect(client.getSpending().totalSpent).toBeCloseTo(0.001, 6)
        },
        90_000
    )
})
