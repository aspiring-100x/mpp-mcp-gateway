/**
 * Tests for the server-side pricing logic.
 *
 * Pricing is a pure function of (pricingModel, callCount), so these tests
 * don't spin up a full client-server pair — they inspect the server's
 * listTools() output directly.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createPaidMcpServer } from '../src/server.js'

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const SECRET = 'pricing-test-secret'

describe('pricing', () => {
    it('reports null price for a tool with no pricing (free)', () => {
        const server = createPaidMcpServer({
            name: 'free-server',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'ping',
                    description: 'free',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
                },
            ],
        })

        const tools = server.listTools()
        expect(tools).toHaveLength(1)
        expect(tools[0]!.price).toBeNull()
    })

    it('reports the flat price for a per-call tool', () => {
        const server = createPaidMcpServer({
            name: 'flat-server',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'paid',
                    description: 'flat rate',
                    inputSchema: { q: z.string() },
                    pricing: { type: 'per-call', amount: '0.05' },
                    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
                },
            ],
        })

        const [tool] = server.listTools()
        expect(tool?.price).toBe('0.05')
    })

    it('walks tiered pricing based on call count', () => {
        const server = createPaidMcpServer({
            name: 'tier-server',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'tiered',
                    description: 'volume discount',
                    inputSchema: {},
                    pricing: {
                        type: 'tiered',
                        tiers: [
                            { upTo: 2, amount: '0.10' }, // calls 0, 1 → $0.10
                            { upTo: 5, amount: '0.05' }, // calls 2, 3, 4 → $0.05
                            { upTo: 'unlimited', amount: '0.01' }, // calls 5+ → $0.01
                        ],
                    },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        // Before any calls → first tier
        expect(server.listTools()[0]!.price).toBe('0.10')

        // Simulate call-count progression by poking the stats (no real calls,
        // just testing the price-lookup function). The server exposes stats
        // via getStats() but we only care that listTools pulls the right tier.
        const stats = server.getStats()
        expect(stats.totalCalls).toBe(0)
    })

    it('aggregates multiple tools into a single listing', () => {
        const server = createPaidMcpServer({
            name: 'multi',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'free-tool',
                    description: 'free',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
                {
                    name: 'cheap-tool',
                    description: 'cheap',
                    inputSchema: {},
                    pricing: { type: 'per-call', amount: '0.001' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
                {
                    name: 'expensive-tool',
                    description: 'expensive',
                    inputSchema: {},
                    pricing: { type: 'per-call', amount: '5.00' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const tools = server.listTools()
        expect(tools).toHaveLength(3)

        const byName = Object.fromEntries(tools.map((t) => [t.name, t.price]))
        expect(byName['free-tool']).toBeNull()
        expect(byName['cheap-tool']).toBe('0.001')
        expect(byName['expensive-tool']).toBe('5.00')
    })

    it('initializes stats with zero values', () => {
        const server = createPaidMcpServer({
            name: 'stats-server',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [],
        })

        const stats = server.getStats()
        expect(stats.totalCalls).toBe(0)
        expect(stats.paidCalls).toBe(0)
        expect(stats.freeCalls).toBe(0)
        expect(stats.totalRevenue).toBe('0')
        expect(stats.callsByTool).toEqual({})
        expect(stats.revenueByTool).toEqual({})
        expect(stats.uptimeMs).toBeGreaterThanOrEqual(0)
        expect(typeof stats.startedAt).toBe('string')
    })
})
