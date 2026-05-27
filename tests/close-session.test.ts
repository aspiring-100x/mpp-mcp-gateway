/**
 * Tests for client.closeSession and client.getOpenSessions.
 *
 * Three layers:
 *
 *   1. **Empty state** — fresh client has no open sessions; close
 *      on a non-existent tool returns the typed "no channel" outcome.
 *
 *   2. **State tracking via direct manipulation** — we poke the
 *      private `openSessions` Map to simulate channel state being
 *      established. This pins the public-API contract without
 *      requiring a real on-chain channel.
 *
 *   3. **Wire-shape verification** — we install a stub onto the
 *      client's private `wrapped` field and confirm `closeSession`
 *      hands the right context to `wrapped.callTool` (action=close,
 *      channelId, cumulativeAmountRaw).
 *
 * The full end-to-end path — open a real channel, settle it
 * cooperatively — lives in the integration test suite
 * (tests/sessions-flow.test.ts) which hits Tempo testnet. Here we
 * verify the local logic that wraps it.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { makeConnectedPair } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

/** Internal-state poke surface for tests. */
interface ClientInternals {
    openSessions: Map<
        string,
        {
            channelId: string
            cumulativeAmount: bigint
            escrowContract: string
            chainId: number
            updatedAt: number
        }
    >
    wrapped: {
        callTool: (
            params: { name: string; arguments?: Record<string, unknown> },
            options?: { context?: unknown }
        ) => Promise<{
            content: unknown[]
            receipt?: { method: string; reference: string; timestamp: string }
        }>
    }
}

describe('getOpenSessions — empty state', () => {
    it('returns an empty record on a fresh client', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        expect(client.getOpenSessions()).toEqual({})
    })

    it('snapshot is independent of internal state', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const internal = client as unknown as ClientInternals
        internal.openSessions.set('streamy', {
            channelId: '0xchan',
            cumulativeAmount: 1000n,
            escrowContract: '0xescrow',
            chainId: 42431,
            updatedAt: Date.now(),
        })

        const snapshot = client.getOpenSessions()
        expect(Object.keys(snapshot)).toEqual(['streamy'])
        // Mutating the snapshot must not mutate the source.
        snapshot.streamy!.cumulativeAmount = 9999n
        const second = client.getOpenSessions()
        expect(second.streamy!.cumulativeAmount).toBe(1000n)
    })
})

describe('closeSession — no open channel', () => {
    it('returns no-open-channel for an unknown tool', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const result = await client.closeSession('streamy')
        expect(result).toEqual({ closed: false, reason: 'no-open-channel' })
    })

    it('idempotent — closing twice returns no-open-channel both times', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const a = await client.closeSession('streamy')
        const b = await client.closeSession('streamy')
        expect(a).toEqual({ closed: false, reason: 'no-open-channel' })
        expect(b).toEqual({ closed: false, reason: 'no-open-channel' })
    })
})

describe('closeSession — wire shape', () => {
    it('passes the close context to wrapped.callTool', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const internal = client as unknown as ClientInternals
        internal.openSessions.set('streamy', {
            channelId: '0xchannel123',
            cumulativeAmount: 5000n,
            escrowContract: '0xescrow',
            chainId: 42431,
            updatedAt: Date.now(),
        })

        // Capture every call into the wrapped client's callTool.
        let captured: {
            name?: string
            options?: { context?: Record<string, unknown> }
        } = {}
        internal.wrapped = {
            callTool: async (params, options) => {
                captured = {
                    name: params.name,
                    options,
                }
                return {
                    content: [],
                    receipt: {
                        method: 'tempo',
                        reference: '0xtxhash',
                        timestamp: new Date().toISOString(),
                    },
                }
            },
        }

        const result = await client.closeSession('streamy')
        expect(result).toEqual({
            closed: true,
            receipt: expect.objectContaining({
                method: 'tempo',
                reference: '0xtxhash',
            }),
        })

        // The right tool name was passed.
        expect(captured.name).toBe('streamy')
        // Context carries action=close and the tracked channel state.
        const ctx = captured.options?.context as Record<string, unknown>
        expect(ctx).toBeDefined()
        expect(ctx.action).toBe('close')
        expect(ctx.channelId).toBe('0xchannel123')
        expect(ctx.cumulativeAmountRaw).toBe('5000')
    })

    it('clears local state after successful close', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const internal = client as unknown as ClientInternals
        internal.openSessions.set('streamy', {
            channelId: '0xchan',
            cumulativeAmount: 1000n,
            escrowContract: '0xescrow',
            chainId: 42431,
            updatedAt: Date.now(),
        })
        internal.wrapped = {
            callTool: async () => ({
                content: [],
                receipt: {
                    method: 'tempo',
                    reference: '0xtxhash',
                    timestamp: new Date().toISOString(),
                },
            }),
        }

        await client.closeSession('streamy')
        expect(client.getOpenSessions()).toEqual({})
    })

    it('does not clear state for OTHER tools', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const internal = client as unknown as ClientInternals
        internal.openSessions.set('streamy', {
            channelId: '0xa',
            cumulativeAmount: 100n,
            escrowContract: '0xescrow',
            chainId: 42431,
            updatedAt: Date.now(),
        })
        internal.openSessions.set('thinky', {
            channelId: '0xb',
            cumulativeAmount: 200n,
            escrowContract: '0xescrow',
            chainId: 42431,
            updatedAt: Date.now(),
        })
        internal.wrapped = {
            callTool: async () => ({
                content: [],
                receipt: {
                    method: 'tempo',
                    reference: '0xtxhash',
                    timestamp: new Date().toISOString(),
                },
            }),
        }

        await client.closeSession('streamy')

        const remaining = client.getOpenSessions()
        expect(Object.keys(remaining)).toEqual(['thinky'])
    })

    it('throws when wrapped.callTool returns no receipt', async () => {
        const { client, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const internal = client as unknown as ClientInternals
        internal.openSessions.set('streamy', {
            channelId: '0xa',
            cumulativeAmount: 100n,
            escrowContract: '0xescrow',
            chainId: 42431,
            updatedAt: Date.now(),
        })
        internal.wrapped = {
            callTool: async () => ({
                content: [],
                // No receipt — server didn't ack the close.
            }),
        }

        await expect(client.closeSession('streamy')).rejects.toThrow(
            /no receipt — close may not have settled/
        )
    })
})
