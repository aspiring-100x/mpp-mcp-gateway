/**
 * Unit tests for session-pricing wiring.
 *
 * These tests don't open real on-chain channels — they verify:
 *   1. The price-lookup helper handles `type: 'session'` correctly.
 *   2. listTools() reports the per-unit price for session-priced tools.
 *   3. The server stats include session-flavored counters from day one.
 *   4. The client surfaces a `SessionDepositCapExceededError` when the
 *      server suggests a deposit larger than the configured cap, BEFORE
 *      any signing happens.
 *   5. The constructor rejects a non-positive maxSessionDeposit.
 *
 * Real channel-open and voucher round-trips are covered by the integration
 * test in tests/sessions-flow.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { SessionDepositCapExceededError, createPaidMcpClient } from '../src/index.js'
import { createPaidMcpServer } from '../src/server.js'
import { makeConnectedPair, TEST_AGENT_KEY } from './helpers.js'

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const SECRET = 'session-test-secret'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

describe('session pricing', () => {
    it('reports the per-unit price for a session-priced tool', () => {
        const server = createPaidMcpServer({
            name: 'session-price-server',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'streamy',
                    description: 'Pay per second.',
                    inputSchema: { duration: z.number() },
                    pricing: {
                        type: 'session',
                        amount: '0.0001',
                        unitType: 'second',
                        suggestedDeposit: '0.50',
                    },
                    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
                },
            ],
        })

        const [tool] = server.listTools()
        expect(tool?.price).toBe('0.0001')
    })

    it('initializes session counters in stats', () => {
        const server = createPaidMcpServer({
            name: 'session-stats-server',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 's',
                    description: '',
                    inputSchema: {},
                    pricing: { type: 'session', amount: '0.0001', unitType: 'request' },
                    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
                },
            ],
        })

        const stats = server.getStats()
        expect(stats.sessionCalls).toBe(0)
        expect(stats.sessionsOpened).toBe(0)
        expect(stats.sessionsClosed).toBe(0)
    })

    it('mixes session and per-call pricing on the same server', () => {
        const server = createPaidMcpServer({
            name: 'mixed-pricing-server',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'one-shot',
                    description: '',
                    inputSchema: {},
                    pricing: { type: 'per-call', amount: '0.01' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
                {
                    name: 'streamy',
                    description: '',
                    inputSchema: {},
                    pricing: { type: 'session', amount: '0.0001', unitType: 'request' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
                {
                    name: 'free',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const byName = Object.fromEntries(server.listTools().map((t) => [t.name, t.price]))
        expect(byName['one-shot']).toBe('0.01')
        expect(byName['streamy']).toBe('0.0001')
        expect(byName['free']).toBeNull()
    })
})

describe('session caps', () => {
    it('constructor rejects non-positive maxSessionDeposit', () => {
        expect(() =>
            createPaidMcpClient({
                name: 'bad',
                version: '0',
                privateKey: TEST_AGENT_KEY,
                maxSessionDeposit: '0',
            })
        ).toThrow(/maxSessionDeposit must be a positive number/)

        expect(() =>
            createPaidMcpClient({
                name: 'bad',
                version: '0',
                privateKey: TEST_AGENT_KEY,
                maxSessionDeposit: '-5',
            })
        ).toThrow(/maxSessionDeposit must be a positive number/)
    })

    it('rejects a session call when suggestedDeposit exceeds maxSessionDeposit', async () => {
        // Server suggests $5 deposit, client only allows $0.10.
        const { client, dispose } = await makeConnectedPair({
            clientConfig: {
                maxPerCall: '1.00',
                maxTotal: '100.00',
                maxSessionDeposit: '0.10',
            },
            tools: [
                {
                    name: 'pricey-stream',
                    description: 'Suggests a $5 deposit.',
                    inputSchema: {},
                    pricing: {
                        type: 'session',
                        amount: '0.0001',
                        unitType: 'request',
                        suggestedDeposit: '5.00',
                    },
                    handler: async () => ({ content: [{ type: 'text', text: 'never' }] }),
                },
            ],
        })
        cleanup.push(dispose)

        await expect(client.callTool('pricey-stream')).rejects.toBeInstanceOf(
            SessionDepositCapExceededError
        )

        // No spend should have been recorded.
        const spending = client.getSpending()
        expect(spending.totalSpent).toBe(0)
    })

    it('exposes maxSessionDeposit and cumulativeVoucher in getSpending', async () => {
        const { client, dispose } = await makeConnectedPair({
            clientConfig: {
                maxPerCall: '0.50',
                maxTotal: '5.00',
                maxSessionDeposit: '2.00',
            },
            tools: [],
        })
        cleanup.push(dispose)

        const spending = client.getSpending()
        expect(spending.maxSessionDeposit).toBeCloseTo(2.0)
        expect(spending.cumulativeVoucher).toBe(0)
    })
})
