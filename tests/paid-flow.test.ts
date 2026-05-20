/**
 * End-to-end paid-flow integration test.
 *
 * This test executes a REAL on-chain transaction on Tempo testnet. It requires
 * the default Anvil key to have pathUSD balance, which is true on Tempo
 * Moderato as of May 2026. The test takes ~1-2s (one block finality).
 *
 * If you want to skip network tests (e.g. in CI without testnet access),
 * set RUN_INTEGRATION=false in the environment.
 */

import { describe, expect, it, afterEach } from 'vitest'
import { z } from 'zod'

import { makeConnectedPair } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

// Allow disabling the integration test if offline.
const RUN_INTEGRATION = process.env.RUN_INTEGRATION !== 'false'
const maybeIt = RUN_INTEGRATION ? it : it.skip

describe('paid flow (integration — hits Tempo testnet)', () => {
    maybeIt(
        'executes a real $0.001 payment and returns a receipt with a tx hash',
        async () => {
            const { client, server, dispose } = await makeConnectedPair({
                clientConfig: { maxPerCall: '1.00', maxTotal: '1.00' },
                tools: [
                    {
                        name: 'tiny_paid_echo',
                        description: 'Costs $0.001 per call.',
                        inputSchema: { msg: z.string() },
                        pricing: { type: 'per-call', amount: '0.001' },
                        handler: async ({ msg }) => ({
                            content: [{ type: 'text', text: `ECHO: ${String(msg)}` }],
                        }),
                    },
                ],
            })
            cleanup.push(dispose)

            const result = await client.callTool('tiny_paid_echo', { msg: 'hi' })

            // Assert: we got the tool result
            expect(result.content[0]?.text).toBe('ECHO: hi')

            // Assert: the payment succeeded and left a receipt
            expect(result.paid).toBe(true)
            expect(result.receipt).toBeDefined()
            expect(result.receipt!.method).toBe('tempo')
            expect(result.receipt!.reference).toMatch(/^0x[0-9a-fA-F]{64}$/)
            expect(result.receipt!.timestamp).toMatch(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
            )
            expect(result.receipt!.amount).toBe('0.001000')

            // Assert: the client tracked the spend
            const spending = client.getSpending()
            expect(spending.totalSpent).toBeCloseTo(0.001, 6)

            // Assert: the server recorded the call and revenue
            const stats = server.getStats()
            expect(stats.totalCalls).toBe(1)
            expect(stats.paidCalls).toBe(1)
            expect(stats.freeCalls).toBe(0)
            expect(stats.totalRevenue).toBe('0.001000')
            expect(stats.callsByTool['tiny_paid_echo']).toBe(1)
        },
        60_000
    )
})
