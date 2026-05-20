/**
 * Tests for the dashboard HTTP API and the call-log ring buffer.
 *
 * Spins up an Express app on an ephemeral port, mounts dashboard routes
 * on it, drives a few free-tool calls through an in-memory MCP transport,
 * and verifies the JSON shape of `/api/stats`, `/api/tools`, and `/api/calls`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { z } from 'zod'

import { mountDashboard } from '../src/dashboard.js'
import { createPaidMcpServer } from '../src/server.js'
import { makeConnectedPair } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const

describe('call log (ring buffer)', () => {
    it('records free-tool calls with paymentMode=free', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'echo',
                    description: 'Free echo.',
                    inputSchema: { msg: z.string() },
                    handler: async ({ msg }) => ({
                        content: [{ type: 'text', text: `ECHO: ${String(msg)}` }],
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        await client.callTool('echo', { msg: 'a' })
        await client.callTool('echo', { msg: 'b' })

        const calls = server.getRecentCalls()
        expect(calls).toHaveLength(2)
        // newest first
        expect(calls[0]?.tool).toBe('echo')
        expect(calls[0]?.paid).toBe(false)
        expect(calls[0]?.paymentMode).toBe('free')
        expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(0)
        expect(calls[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('returns at most `limit` calls', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'noop',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })
        cleanup.push(dispose)

        for (let i = 0; i < 10; i++) {
            await client.callTool('noop')
        }
        expect(server.getRecentCalls(3)).toHaveLength(3)
        expect(server.getRecentCalls(100)).toHaveLength(10)
    })

    it('caps the buffer at callLogSize and drops the oldest entries', () => {
        const server = createPaidMcpServer({
            name: 'cap-test',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: 's',
            callLogSize: 3,
            tools: [],
        })

        // Poke the internal append helper through the prototype to add 5
        // synthetic entries.
        const internal = server as unknown as {
            appendCall: (e: import('../src/types.js').CallLogEntry) => void
        }
        for (let i = 0; i < 5; i++) {
            internal.appendCall({
                tool: 't',
                timestamp: new Date().toISOString(),
                durationMs: 1,
                paid: false,
                paymentMode: 'free',
                amount: undefined,
                error: `e${i}`,
            } as never)
        }

        const calls = server.getRecentCalls()
        expect(calls).toHaveLength(3)
        // Newest is the last appended (`e4`), and the oldest 2 (`e0`, `e1`)
        // should have been dropped.
        const errs = calls.map((c) => c.error)
        expect(errs).toEqual(['e4', 'e3', 'e2'])
    })

    it('callLogSize=0 disables logging entirely', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            serverConfig: { callLogSize: 0 },
            tools: [
                {
                    name: 'noop',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })
        cleanup.push(dispose)

        await client.callTool('noop')
        await client.callTool('noop')
        expect(server.getRecentCalls()).toEqual([])
    })
})

describe('dashboard HTTP API', () => {
    async function setup() {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'free-tool',
                    description: 'free',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
                },
                {
                    name: 'paid-tool',
                    description: 'per-call paid',
                    inputSchema: {},
                    pricing: { type: 'per-call', amount: '0.01' },
                    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
                },
            ],
        })
        const app = express()
        mountDashboard(server, app)
        const httpServer = app.listen(0)
        await new Promise<void>((r) => httpServer.on('listening', () => r()))
        const addr = httpServer.address()
        if (!addr || typeof addr === 'string') {
            throw new Error('Failed to bind ephemeral port')
        }
        const baseUrl = `http://127.0.0.1:${addr.port}`
        cleanup.push(async () => {
            httpServer.close()
            await dispose()
        })
        return { client, server, baseUrl }
    }

    it('GET /api/stats returns the current GatewayStats', async () => {
        const { client, baseUrl } = await setup()
        await client.callTool('free-tool')

        const res = await fetch(`${baseUrl}/api/stats`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as { stats: { totalCalls: number; freeCalls: number } }
        expect(body.stats.totalCalls).toBe(1)
        expect(body.stats.freeCalls).toBe(1)
    })

    it('GET /api/tools returns serializable tool descriptors', async () => {
        const { baseUrl } = await setup()

        const res = await fetch(`${baseUrl}/api/tools`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as {
            tools: Array<{ name: string; description: string; price: string | null }>
        }
        const byName = Object.fromEntries(body.tools.map((t) => [t.name, t]))
        expect(byName['free-tool']!.price).toBeNull()
        expect(byName['paid-tool']!.price).toBe('0.01')
        // Ensure no Zod schema leaked into the JSON response.
        for (const t of body.tools) {
            expect((t as Record<string, unknown>).inputSchema).toBeUndefined()
        }
    })

    it('GET /api/calls returns newest-first entries respecting limit', async () => {
        const { client, baseUrl } = await setup()
        for (let i = 0; i < 5; i++) await client.callTool('free-tool')

        const allRes = await fetch(`${baseUrl}/api/calls`)
        const all = (await allRes.json()) as {
            calls: Array<{ tool: string; paid: boolean }>
        }
        expect(all.calls).toHaveLength(5)
        expect(all.calls.every((c) => c.tool === 'free-tool' && c.paid === false)).toBe(true)

        const fewRes = await fetch(`${baseUrl}/api/calls?limit=2`)
        const few = (await fewRes.json()) as { calls: unknown[] }
        expect(few.calls).toHaveLength(2)
    })

    it('GET /api/calls clamps limit to a sane maximum', async () => {
        const { baseUrl } = await setup()

        const res = await fetch(`${baseUrl}/api/calls?limit=999999`)
        expect(res.status).toBe(200)
        // No calls happened, so the response is empty — but importantly it
        // shouldn't have crashed or hung. The clamp is internal; we test
        // the no-crash property.
        const body = (await res.json()) as { calls: unknown[] }
        expect(Array.isArray(body.calls)).toBe(true)
    })

    it('respects the prefix option', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'noop',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: '' }] }),
                },
            ],
        })
        const app = express()
        mountDashboard(server, app, { prefix: '/admin/v1' })
        const httpServer = app.listen(0)
        await new Promise<void>((r) => httpServer.on('listening', () => r()))
        const addr = httpServer.address()
        if (!addr || typeof addr === 'string') throw new Error('bad addr')
        const url = `http://127.0.0.1:${addr.port}/admin/v1/stats`
        cleanup.push(async () => {
            httpServer.close()
            await dispose()
        })

        await client.callTool('noop')

        const res = await fetch(url)
        expect(res.status).toBe(200)
        const body = (await res.json()) as { stats: { totalCalls: number } }
        expect(body.stats.totalCalls).toBe(1)
    })

    it('honours the middleware option', async () => {
        const { server, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const app = express()
        // Middleware that 401s every dashboard request.
        mountDashboard(server, app, {
            middleware: (_req, res, _next) => {
                res.status(401).send('nope')
            },
        })
        const httpServer = app.listen(0)
        await new Promise<void>((r) => httpServer.on('listening', () => r()))
        const addr = httpServer.address()
        if (!addr || typeof addr === 'string') throw new Error('bad addr')
        cleanup.push(async () => {
            httpServer.close()
        })

        const res = await fetch(`http://127.0.0.1:${addr.port}/api/stats`)
        expect(res.status).toBe(401)
    })
})
