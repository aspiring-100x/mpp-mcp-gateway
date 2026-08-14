/**
 * Tests for multi-currency offers in discovery.
 *
 * When a pricing model includes an `accept` array, the discovery
 * endpoint emits one offer per accepted currency instead of the
 * single default-currency offer. Backward compatible: omitting
 * `accept` produces the same single-offer behavior as before.
 */

import { describe, expect, it } from 'vitest'

import { buildOpenApi } from '../src/discovery.js'
import { createPaidMcpServer } from '../src/server.js'
import { TESTNET_TOKENS } from '../src/constants.js'
import { TEST_AGENT_KEY } from './helpers.js'

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const SECRET = 'multi-currency-test-secret'

function getOffers(doc: Record<string, unknown>, toolName: string) {
    const paths = doc.paths as Record<string, { post: Record<string, unknown> }>
    const op = paths[`/tools/${toolName}`]!.post
    return (op['x-payment-info'] as { offers: Array<Record<string, unknown>> }).offers
}

describe('multi-currency discovery offers', () => {
    it('emits multiple offers for per-call pricing with accept array', () => {
        const server = createPaidMcpServer({
            name: 'multi',
            version: '1.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'weather',
                    description: 'Get weather',
                    inputSchema: {},
                    pricing: {
                        type: 'per-call',
                        amount: '0.001',
                        accept: [
                            { currency: TESTNET_TOKENS.pathUSD, amount: '0.001' },
                            { currency: TESTNET_TOKENS.alphaUSD, amount: '0.001' },
                            { currency: TESTNET_TOKENS.betaUSD, amount: '0.002' },
                        ],
                    },
                    handler: async () => ({ content: [{ type: 'text', text: 'sunny' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const offers = getOffers(doc, 'weather')

        expect(offers).toHaveLength(3)
        expect(offers[0]).toMatchObject({
            intent: 'charge',
            method: 'tempo',
            amount: '1000', // 0.001 * 10^6
            currency: TESTNET_TOKENS.pathUSD,
        })
        expect(offers[1]).toMatchObject({
            intent: 'charge',
            method: 'tempo',
            amount: '1000',
            currency: TESTNET_TOKENS.alphaUSD,
        })
        expect(offers[2]).toMatchObject({
            intent: 'charge',
            method: 'tempo',
            amount: '2000', // 0.002 * 10^6
            currency: TESTNET_TOKENS.betaUSD,
        })
    })

    it('falls back to single offer when accept is omitted (per-call)', () => {
        const server = createPaidMcpServer({
            name: 'single',
            version: '1.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'echo',
                    description: 'Echo',
                    inputSchema: {},
                    pricing: { type: 'per-call', amount: '0.005' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const offers = getOffers(doc, 'echo')

        expect(offers).toHaveLength(1)
        expect(offers[0]!.amount).toBe('5000')
    })

    it('emits multiple offers for session pricing with accept array', () => {
        const server = createPaidMcpServer({
            name: 'multi-session',
            version: '1.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            sessionAccountKey: TEST_AGENT_KEY,
            tools: [
                {
                    name: 'stream',
                    description: 'Streaming tool',
                    inputSchema: {},
                    pricing: {
                        type: 'session',
                        amount: '0.0001',
                        unitType: 'token',
                        accept: [
                            { currency: TESTNET_TOKENS.pathUSD, amount: '0.0001' },
                            { currency: TESTNET_TOKENS.alphaUSD, amount: '0.00015' },
                        ],
                    },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const offers = getOffers(doc, 'stream')

        expect(offers).toHaveLength(2)
        expect(offers[0]).toMatchObject({
            intent: 'session',
            method: 'tempo',
            amount: '100', // 0.0001 * 10^6
            currency: TESTNET_TOKENS.pathUSD,
        })
        expect(offers[1]).toMatchObject({
            intent: 'session',
            method: 'tempo',
            amount: '150', // 0.00015 * 10^6
            currency: TESTNET_TOKENS.alphaUSD,
        })
        // Each session offer should carry the unitType description
        expect(offers[0]!.description).toContain('token')
        expect(offers[1]!.description).toContain('token')
    })

    it('emits multiple offers for access-key pricing with accept array', () => {
        const server = createPaidMcpServer({
            name: 'multi-ak',
            version: '1.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'premium',
                    description: 'Premium access',
                    inputSchema: {},
                    pricing: {
                        type: 'access-key',
                        amount: '5',
                        validFor: '30d',
                        maxCalls: 1000,
                        accept: [
                            { currency: TESTNET_TOKENS.pathUSD, amount: '5' },
                            { currency: TESTNET_TOKENS.thetaUSD, amount: '4.50' },
                        ],
                    },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const offers = getOffers(doc, 'premium')

        expect(offers).toHaveLength(2)
        expect(offers[0]).toMatchObject({
            intent: 'charge',
            method: 'tempo',
            amount: '5000000', // 5 * 10^6
            currency: TESTNET_TOKENS.pathUSD,
        })
        expect(offers[1]).toMatchObject({
            intent: 'charge',
            method: 'tempo',
            amount: '4500000', // 4.50 * 10^6
            currency: TESTNET_TOKENS.thetaUSD,
        })
        // Both offers should carry the access-key description
        expect(offers[0]!.description).toContain('valid for 30d')
        expect(offers[0]!.description).toContain('1000 calls')
        expect(offers[1]!.description).toContain('valid for 30d')
    })

    it('handles empty accept array same as omitted', () => {
        const server = createPaidMcpServer({
            name: 'empty-accept',
            version: '1.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'tool',
                    description: 'tool',
                    inputSchema: {},
                    pricing: {
                        type: 'per-call',
                        amount: '0.01',
                        accept: [],
                    },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const offers = getOffers(doc, 'tool')

        // Empty accept → falls back to default single offer
        expect(offers).toHaveLength(1)
        expect(offers[0]!.amount).toBe('10000')
    })

    it('different amounts per currency reflect in base units correctly', () => {
        const server = createPaidMcpServer({
            name: 'diff-amounts',
            version: '1.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'api',
                    description: 'API call',
                    inputSchema: {},
                    pricing: {
                        type: 'per-call',
                        amount: '0.001',
                        accept: [
                            { currency: TESTNET_TOKENS.pathUSD, amount: '0.001' },
                            { currency: TESTNET_TOKENS.alphaUSD, amount: '0.0015' },
                        ],
                    },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        // With 18 decimals (like ETH-style tokens)
        const doc = buildOpenApi(server, {}, 18)
        const offers = getOffers(doc, 'api')

        expect(offers[0]!.amount).toBe('1000000000000000') // 0.001 * 10^18
        expect(offers[1]!.amount).toBe('1500000000000000') // 0.0015 * 10^18
    })
})
