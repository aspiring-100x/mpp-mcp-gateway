/**
 * Tests for the discovery (OpenAPI + x-payment-info) feature.
 *
 * Validates document structure against the MPP service-discovery IETF
 * draft. We don't crawl the live mpp.land registry from CI; we just
 * confirm our generated spec matches the schema mpp.land expects.
 */

import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { z } from 'zod'

import { buildOpenApi, mountDiscovery } from '../src/discovery.js'
import { createPaidMcpServer } from '../src/server.js'

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const SECRET = 'discovery-test-secret'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

describe('buildOpenApi', () => {
    it('emits a minimal valid OpenAPI 3.1 document for an empty server', () => {
        const server = createPaidMcpServer({
            name: 'minimal',
            version: '1.2.3',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [],
        })

        const doc = buildOpenApi(server)
        expect(doc.openapi).toBe('3.1.0')
        expect((doc.info as { title: string }).title).toBe('minimal')
        expect((doc.info as { version: string }).version).toBe('1.2.3')
        expect(doc.paths).toEqual({})
        expect(doc['x-service-info']).toBeUndefined()
        expect(doc.servers).toBeUndefined()
    })

    it('includes x-service-info when categories or docs are provided', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [],
        })

        const doc = buildOpenApi(server, {
            categories: ['data', 'search'],
            docs: { homepage: 'https://example.com' },
        })

        expect(doc['x-service-info']).toEqual({
            categories: ['data', 'search'],
            docs: { homepage: 'https://example.com' },
        })
    })

    it('emits a server entry when baseUrl is provided', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [],
        })

        const doc = buildOpenApi(server, { baseUrl: 'https://api.example.com' })
        expect(doc.servers).toEqual([{ url: 'https://api.example.com' }])
    })

    it('skips x-payment-info on free tools and omits the 402 response', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'free',
                    description: 'no charge',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const op = (doc.paths as Record<string, { post: Record<string, unknown> }>)
        ['/tools/free'].post

        expect(op['x-payment-info']).toBeUndefined()
        expect((op.responses as Record<string, unknown>)['402']).toBeUndefined()
    })

    it('builds a charge offer for per-call pricing', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'cheap',
                    description: 'paid',
                    inputSchema: { msg: z.string() },
                    pricing: { type: 'per-call', amount: '0.001' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const op = (doc.paths as Record<string, { post: Record<string, unknown> }>)
        ['/tools/cheap'].post
        const xPay = op['x-payment-info'] as { offers: Array<Record<string, unknown>> }

        expect(xPay.offers).toHaveLength(1)
        expect(xPay.offers[0]).toMatchObject({
            intent: 'charge',
            method: 'tempo',
            // 0.001 USD * 10^6 decimals = 1000 base units
            amount: '1000',
        })
        expect(xPay.offers[0]!.currency).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect((op.responses as Record<string, unknown>)['402']).toBeDefined()
    })

    it('builds a session offer for session pricing', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'streamy',
                    description: 'session',
                    inputSchema: {},
                    pricing: { type: 'session', amount: '0.0001', unitType: 'second' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const op = (doc.paths as Record<string, { post: Record<string, unknown> }>)
        ['/tools/streamy'].post
        const xPay = op['x-payment-info'] as { offers: Array<Record<string, unknown>> }

        expect(xPay.offers[0]).toMatchObject({
            intent: 'session',
            method: 'tempo',
            amount: '100', // 0.0001 * 10^6
        })
        expect(xPay.offers[0]!.description).toMatch(/per-second/i)
    })

    it('builds an access-key offer with a description summarizing bounds', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'subbed',
                    description: 'subscription',
                    inputSchema: {},
                    pricing: {
                        type: 'access-key',
                        amount: '5',
                        validFor: '7d',
                        maxCalls: 1000,
                    },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const op = (doc.paths as Record<string, { post: Record<string, unknown> }>)
        ['/tools/subbed'].post
        const xPay = op['x-payment-info'] as { offers: Array<Record<string, unknown>> }

        expect(xPay.offers[0]).toMatchObject({
            intent: 'charge',
            method: 'tempo',
            amount: '5000000', // 5 * 10^6
        })
        expect(xPay.offers[0]!.description).toContain('valid for 7d')
        expect(xPay.offers[0]!.description).toContain('1000 calls')
    })

    it('advertises tiered pricing using the cheapest tier', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
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
                            { upTo: 100, amount: '0.01' },
                            { upTo: 1000, amount: '0.005' },
                            { upTo: 'unlimited', amount: '0.001' },
                        ],
                    },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const op = (doc.paths as Record<string, { post: Record<string, unknown> }>)
        ['/tools/tiered'].post
        const xPay = op['x-payment-info'] as { offers: Array<Record<string, unknown>> }

        expect(xPay.offers[0]).toMatchObject({
            intent: 'charge',
            method: 'tempo',
            amount: '1000', // 0.001 base case
        })
        expect(xPay.offers[0]!.description).toContain('Tiered')
    })

    it('translates Zod input schemas to JSON Schema', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'schemed',
                    description: 'has schema',
                    inputSchema: {
                        city: z.string().describe('City name'),
                        days: z.number().int().min(1).max(14).default(7),
                    },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const op = (doc.paths as Record<string, { post: Record<string, unknown> }>)
        ['/tools/schemed'].post
        const schema = (
            (op.requestBody as Record<string, Record<string, Record<string, unknown>>>)
                .content['application/json'].schema
        ) as { type: string; properties: Record<string, { type: string }>; required?: string[] }

        expect(schema.type).toBe('object')
        expect(schema.properties.city!.type).toBe('string')
        expect(schema.properties.days!.type).toBe('integer')
        // The $schema field shouldn't leak into OpenAPI fragments.
        expect((schema as Record<string, unknown>).$schema).toBeUndefined()
    })

    it('emits an empty object schema for tools with no inputs', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'noargs',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const doc = buildOpenApi(server)
        const op = (doc.paths as Record<string, { post: Record<string, unknown> }>)
        ['/tools/noargs'].post
        const schema = (
            (op.requestBody as Record<string, Record<string, Record<string, unknown>>>)
                .content['application/json'].schema
        ) as { type: string }
        expect(schema.type).toBe('object')
    })

    it('honours a custom decimals override', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'paid',
                    description: '',
                    inputSchema: {},
                    pricing: { type: 'per-call', amount: '1' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        // 18-decimal currency (e.g. ETH) → 1 ETH = 10^18 base units
        const doc = buildOpenApi(server, {}, 18)
        const xPay = (
            (doc.paths as Record<string, { post: Record<string, unknown> }>)
            ['/tools/paid'].post['x-payment-info']
        ) as { offers: Array<Record<string, unknown>> }
        expect(xPay.offers[0]!.amount).toBe('1000000000000000000')
    })
})

describe('mountDiscovery (HTTP)', () => {
    async function setup(opts?: Parameters<typeof mountDiscovery>[2]) {
        const server = createPaidMcpServer({
            name: 'http-disc',
            version: '0.1.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'echo',
                    description: 'free echo',
                    inputSchema: { msg: z.string() },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
                {
                    name: 'paid_echo',
                    description: 'paid echo',
                    inputSchema: { msg: z.string() },
                    pricing: { type: 'per-call', amount: '0.001' },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })
        const app = express()
        mountDiscovery(server, app, opts)
        const httpServer = app.listen(0)
        await new Promise<void>((r) => httpServer.on('listening', () => r()))
        const addr = httpServer.address()
        if (!addr || typeof addr === 'string') throw new Error('bad address')
        const baseUrl = `http://127.0.0.1:${addr.port}`
        cleanup.push(async () => {
            httpServer.close()
        })
        return { baseUrl }
    }

    it('serves OpenAPI at /openapi.json by default', async () => {
        const { baseUrl } = await setup()

        const res = await fetch(`${baseUrl}/openapi.json`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toMatch(/application\/json/)
        expect(res.headers.get('cache-control')).toContain('max-age=300')

        const body = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
        expect(body.openapi).toBe('3.1.0')
        expect(Object.keys(body.paths)).toContain('/tools/echo')
        expect(Object.keys(body.paths)).toContain('/tools/paid_echo')
    })

    it('respects the path option', async () => {
        const { baseUrl } = await setup({ path: '/.well-known/mpp.json' })

        const a = await fetch(`${baseUrl}/openapi.json`)
        expect(a.status).toBe(404)

        const b = await fetch(`${baseUrl}/.well-known/mpp.json`)
        expect(b.status).toBe(200)
    })

    it('honours middleware option for auth/CORS', async () => {
        const { baseUrl } = await setup({
            middleware: (req, res, next) => {
                res.set('access-control-allow-origin', '*')
                next()
            },
        })

        const res = await fetch(`${baseUrl}/openapi.json`)
        expect(res.headers.get('access-control-allow-origin')).toBe('*')
    })
})
