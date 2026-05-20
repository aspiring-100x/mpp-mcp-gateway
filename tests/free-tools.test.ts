/**
 * Tests for the free-tool path — no payment, no challenge.
 *
 * These tests use InMemoryTransport, so nothing touches the network.
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

describe('free tools', () => {
    it('round-trips with no payment required', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'echo',
                    description: 'Free echo.',
                    inputSchema: { message: z.string() },
                    handler: async ({ message }) => ({
                        content: [{ type: 'text', text: `ECHO: ${String(message)}` }],
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        const result = await client.callTool('echo', { message: 'hi' })

        expect(result.paid).toBe(false)
        expect(result.receipt).toBeUndefined()
        expect(result.content[0]).toMatchObject({ type: 'text', text: 'ECHO: hi' })

        const stats = server.getStats()
        expect(stats.totalCalls).toBe(1)
        expect(stats.freeCalls).toBe(1)
        expect(stats.paidCalls).toBe(0)
        expect(stats.totalRevenue).toBe('0')
    })

    it('list_tools returns the registered tools', async () => {
        const { client, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'alpha',
                    description: 'Alpha',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: 'a' }] }),
                },
                {
                    name: 'beta',
                    description: 'Beta',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: 'b' }] }),
                },
            ],
        })
        cleanup.push(dispose)

        const tools = await client.listTools()
        const names = tools.map((t) => t.name).sort()
        expect(names).toEqual(['alpha', 'beta'])
    })

    it('tracks independent call counts per free tool', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'a',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: 'a' }] }),
                },
                {
                    name: 'b',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({ content: [{ type: 'text', text: 'b' }] }),
                },
            ],
        })
        cleanup.push(dispose)

        await client.callTool('a')
        await client.callTool('a')
        await client.callTool('b')

        const stats = server.getStats()
        expect(stats.callsByTool).toEqual({ a: 2, b: 1 })
        expect(stats.totalCalls).toBe(3)
        expect(stats.freeCalls).toBe(3)
    })

    it('propagates structured data from handlers', async () => {
        const { client, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'structured',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({
                        content: [{ type: 'text', text: 'see data' }],
                        data: { temperature: 72, units: 'F' },
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        const result = await client.callTool<{ temperature: number; units: string }>(
            'structured'
        )
        expect(result.data).toEqual({ temperature: 72, units: 'F' })
    })
})
