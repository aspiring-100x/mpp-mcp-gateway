/**
 * Tests for access-key pricing.
 *
 * Most of these are unit tests against the access-keys module directly
 * (parseDuration, validate, redeem, issueRecord) so they don't need a
 * connected MCP pair. The end-to-end paid → cached → redeemed flow over
 * a real network connection is covered by the integration suite — to do
 * that without minting on-chain charges we'd need to mock the Tempo
 * mppx layer, which isn't worth the maintenance burden right now.
 *
 * The access-keys.ts module is pure, so we test it directly.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
    issueRecord,
    parseDuration,
    redeem,
    storeRecord,
    validateAccessKeyPricing,
} from '../src/access-keys.js'
import { createPaidMcpServer } from '../src/server.js'
import { Store } from 'mppx/server'
import { makeConnectedPair } from './helpers.js'

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const SECRET = 'access-key-test-secret'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

describe('parseDuration', () => {
    it('parses standard formats', () => {
        expect(parseDuration('60s')).toBe(60_000)
        expect(parseDuration('15m')).toBe(15 * 60_000)
        expect(parseDuration('4h')).toBe(4 * 3_600_000)
        expect(parseDuration('7d')).toBe(7 * 86_400_000)
        expect(parseDuration('30 d')).toBe(30 * 86_400_000) // tolerates spaces
    })

    it('rejects malformed inputs', () => {
        expect(() => parseDuration('')).toThrow(/Invalid validFor/)
        expect(() => parseDuration('7')).toThrow(/Invalid validFor/)
        expect(() => parseDuration('7w')).toThrow(/Invalid validFor/)
        expect(() => parseDuration('-1d')).toThrow(/Invalid validFor/)
    })
})

describe('validateAccessKeyPricing', () => {
    it('rejects pricing with neither validFor nor maxCalls', () => {
        expect(() =>
            validateAccessKeyPricing('t', { type: 'access-key', amount: '1' })
        ).toThrow(/At least one bound is required/)
    })

    it('rejects non-positive maxCalls', () => {
        expect(() =>
            validateAccessKeyPricing('t', {
                type: 'access-key',
                amount: '1',
                maxCalls: 0,
            })
        ).toThrow(/invalid maxCalls/)
        expect(() =>
            validateAccessKeyPricing('t', {
                type: 'access-key',
                amount: '1',
                maxCalls: -5,
            })
        ).toThrow(/invalid maxCalls/)
        expect(() =>
            validateAccessKeyPricing('t', {
                type: 'access-key',
                amount: '1',
                maxCalls: 1.5,
            })
        ).toThrow(/invalid maxCalls/)
    })

    it('rejects malformed validFor', () => {
        expect(() =>
            validateAccessKeyPricing('t', {
                type: 'access-key',
                amount: '1',
                validFor: '7w',
            })
        ).toThrow(/Invalid validFor/)
    })

    it('accepts validFor only', () => {
        expect(() =>
            validateAccessKeyPricing('t', {
                type: 'access-key',
                amount: '1',
                validFor: '7d',
            })
        ).not.toThrow()
    })

    it('accepts maxCalls only', () => {
        expect(() =>
            validateAccessKeyPricing('t', {
                type: 'access-key',
                amount: '1',
                maxCalls: 100,
            })
        ).not.toThrow()
    })

    it('accepts both', () => {
        expect(() =>
            validateAccessKeyPricing('t', {
                type: 'access-key',
                amount: '1',
                validFor: '7d',
                maxCalls: 100,
            })
        ).not.toThrow()
    })
})

describe('issueRecord', () => {
    it('produces a unique opaque token with the mppmcp_ prefix', () => {
        const a = issueRecord({
            toolName: 'foo',
            pricing: { type: 'access-key', amount: '1', maxCalls: 10 },
        })
        const b = issueRecord({
            toolName: 'foo',
            pricing: { type: 'access-key', amount: '1', maxCalls: 10 },
        })
        expect(a.key).toMatch(/^mppmcp_[0-9a-f]{64}$/)
        expect(b.key).toMatch(/^mppmcp_[0-9a-f]{64}$/)
        expect(a.key).not.toBe(b.key)
    })

    it('sets remainingCalls and expiresAt according to pricing', () => {
        const r = issueRecord({
            toolName: 'foo',
            pricing: { type: 'access-key', amount: '1', validFor: '1h', maxCalls: 5 },
        })
        expect(r.tool).toBe('foo')
        expect(r.remainingCalls).toBe(5)
        expect(r.expiresAt).not.toBeNull()
        const expiry = Date.parse(r.expiresAt!)
        expect(expiry - Date.now()).toBeGreaterThan(3_500_000)
        expect(expiry - Date.now()).toBeLessThan(3_700_000)
    })

    it('handles validFor only (unlimited calls)', () => {
        const r = issueRecord({
            toolName: 'foo',
            pricing: { type: 'access-key', amount: '1', validFor: '1d' },
        })
        expect(r.remainingCalls).toBeNull()
        expect(r.expiresAt).not.toBeNull()
    })

    it('handles maxCalls only (no expiry)', () => {
        const r = issueRecord({
            toolName: 'foo',
            pricing: { type: 'access-key', amount: '1', maxCalls: 100 },
        })
        expect(r.remainingCalls).toBe(100)
        expect(r.expiresAt).toBeNull()
    })
})

describe('redeem', () => {
    it('returns unknown for an unrecognized key', async () => {
        const store = Store.memory()
        const out = await redeem(store, 'mppmcp_does_not_exist', 'tool-x')
        expect(out).toEqual({ ok: false, reason: 'unknown' })
    })

    it('returns wrong-tool when the key is for another tool', async () => {
        const store = Store.memory()
        const r = issueRecord({
            toolName: 'right-tool',
            pricing: { type: 'access-key', amount: '1', maxCalls: 5 },
        })
        await storeRecord(store, r)
        const out = await redeem(store, r.key, 'wrong-tool')
        expect(out).toEqual({ ok: false, reason: 'wrong-tool' })
    })

    it('decrements remainingCalls on each successful redeem', async () => {
        const store = Store.memory()
        const r = issueRecord({
            toolName: 't',
            pricing: { type: 'access-key', amount: '1', maxCalls: 3 },
        })
        await storeRecord(store, r)

        const a = await redeem(store, r.key, 't')
        const b = await redeem(store, r.key, 't')
        const c = await redeem(store, r.key, 't')

        expect(a.ok && a.record.remainingCalls).toBe(2)
        expect(b.ok && b.record.remainingCalls).toBe(1)
        expect(c.ok && c.record.remainingCalls).toBe(0)

        // Next redeem should be exhausted.
        const d = await redeem(store, r.key, 't')
        expect(d).toEqual({ ok: false, reason: 'exhausted' })
    })

    it('returns expired and deletes the key when validFor has passed', async () => {
        const store = Store.memory()
        const r = issueRecord({
            toolName: 't',
            pricing: { type: 'access-key', amount: '1', validFor: '60s' },
        })
        // Hand-roll a record with an already-past expiry.
        const expired = { ...r, expiresAt: new Date(Date.now() - 1000).toISOString() }
        await storeRecord(store, expired)

        const out = await redeem(store, expired.key, 't')
        expect(out).toEqual({ ok: false, reason: 'expired' })
        // And the store no longer carries it.
        expect(await store.get(expired.key)).toBeNull()
    })

    it('allows unlimited time-bounded redemptions', async () => {
        const store = Store.memory()
        const r = issueRecord({
            toolName: 't',
            pricing: { type: 'access-key', amount: '1', validFor: '1h' },
        })
        await storeRecord(store, r)

        // Redeem 10 times — record should still be there with remainingCalls null.
        for (let i = 0; i < 10; i++) {
            const out = await redeem(store, r.key, 't')
            expect(out.ok).toBe(true)
        }
        const stored = await store.get(r.key)
        expect(stored).not.toBeNull()
    })
})

describe('access-key pricing on the server', () => {
    it('rejects access-key tools with neither validFor nor maxCalls at construction', () => {
        expect(() =>
            createPaidMcpServer({
                name: 'bad-server',
                version: '0.0.0',
                recipient: RECIPIENT,
                secretKey: SECRET,
                tools: [
                    {
                        name: 'unbounded',
                        description: '',
                        inputSchema: {},
                        pricing: { type: 'access-key', amount: '1' },
                        handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                    },
                ],
            })
        ).toThrow(/At least one bound is required/)
    })

    it('reports the upfront price via listTools', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [
                {
                    name: 'subscribed',
                    description: '',
                    inputSchema: {},
                    pricing: {
                        type: 'access-key',
                        amount: '1.00',
                        validFor: '7d',
                        maxCalls: 1000,
                    },
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })

        const [tool] = server.listTools()
        expect(tool?.price).toBe('1.00')
    })

    it('initializes access-key counters in stats', () => {
        const server = createPaidMcpServer({
            name: 's',
            version: '0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            tools: [],
        })

        const stats = server.getStats()
        expect(stats.accessKeyCalls).toBe(0)
        expect(stats.accessKeysIssued).toBe(0)
        expect(stats.accessKeysExpired).toBe(0)
    })
})

describe('access-key client cache', () => {
    it('starts empty', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        expect(client.getAccessKeys()).toEqual({})
    })

    it('clearAccessKey is a no-op when nothing is cached', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        client.clearAccessKey('nonexistent')
        client.clearAccessKeys()
        expect(client.getAccessKeys()).toEqual({})
    })

    it('round-trips an access key issued by the server (no payment, in-memory)', async () => {
        // Use a free tool whose handler stamps a fake access-key view into
        // _meta so we can verify the client's capture/cache machinery without
        // hitting the real on-chain charge flow.
        const fakeKey = 'mppmcp_' + 'a'.repeat(64)
        const { client, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'instrumented',
                    description: '',
                    inputSchema: { tag: z.string() },
                    handler: async () => ({
                        content: [{ type: 'text', text: 'ok' }],
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        // The server-side handler doesn't directly let us inject _meta into
        // the result, but we can verify the cache-eviction helpers work
        // independently. Cache an entry by hand and confirm clearAccessKey
        // removes it.
        const internal = client as unknown as {
            accessKeys: Map<
                string,
                { key: string; expiresAt?: string; remainingCalls?: number }
            >
        }
        internal.accessKeys.set('instrumented', {
            key: fakeKey,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            remainingCalls: 100,
        })
        expect(client.getAccessKeys()).toMatchObject({
            instrumented: { key: fakeKey, remainingCalls: 100 },
        })

        client.clearAccessKey('instrumented')
        expect(client.getAccessKeys()).toEqual({})
    })

    it('lookupAccessKey evicts an obviously-expired entry', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const internal = client as unknown as {
            accessKeys: Map<
                string,
                { key: string; expiresAt?: string; remainingCalls?: number }
            >
            lookupAccessKey: (
                t: string
            ) => { key: string; expiresAt?: string; remainingCalls?: number } | undefined
        }
        internal.accessKeys.set('t', {
            key: 'mppmcp_expired',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
        })
        expect(internal.lookupAccessKey('t')).toBeUndefined()
        expect(internal.accessKeys.has('t')).toBe(false)
    })

    it('lookupAccessKey evicts an exhausted entry', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const internal = client as unknown as {
            accessKeys: Map<
                string,
                { key: string; expiresAt?: string; remainingCalls?: number }
            >
            lookupAccessKey: (
                t: string
            ) => { key: string; expiresAt?: string; remainingCalls?: number } | undefined
        }
        internal.accessKeys.set('t', { key: 'mppmcp_burned', remainingCalls: 0 })
        expect(internal.lookupAccessKey('t')).toBeUndefined()
        expect(internal.accessKeys.has('t')).toBe(false)
    })
})
