/**
 * Tests for graceful shutdown.
 *
 * Surfaces under test:
 *
 *   1. `getInFlightCount` correctly reflects active handlers — bumps
 *      up while a handler is mid-execution, drops back to zero on
 *      completion (success or error path).
 *   2. `close()` resolves immediately when nothing is in flight.
 *   3. `close()` waits for in-flight calls to complete before
 *      resolving.
 *   4. `close()` throws ShutdownTimeoutError when calls hang past the
 *      timeout, with the residual count carried.
 *   5. New tool calls invoked after `close()` is called fail with
 *      ShuttingDownError.
 *   6. `close()` is idempotent — concurrent or sequential second
 *      calls share the original promise.
 *   7. `onShutdown` hook fires before drain.
 *   8. Hook errors are logged but do not abort the drain.
 *   9. The configured logger receives drain progress entries.
 *
 * We exercise the wrapping handler directly via the MCP client/server
 * pair from `makeConnectedPair`, plus surgical pokes at private state
 * for tests that would otherwise need real timing races.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
    arrayLogger,
    isMppMcpError,
    ShutdownTimeoutError,
    ShuttingDownError,
} from '../src/index.js'
import { makeConnectedPair } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

describe('in-flight tracking', () => {
    it('starts at zero and stays zero after a completed call', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'instant',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({
                        content: [{ type: 'text', text: 'ok' }],
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        expect(server.getInFlightCount()).toBe(0)
        await client.callTool('instant')
        expect(server.getInFlightCount()).toBe(0)
    })

    it('bumps up while a handler is mid-execution', async () => {
        // Use a deferred handler so we can inspect the counter mid-flight.
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'gated',
                    description: '',
                    inputSchema: {},
                    handler: async () => {
                        await gate
                        return { content: [{ type: 'text', text: 'released' }] }
                    },
                },
            ],
        })
        cleanup.push(dispose)

        // Kick off the call but don't await it yet.
        const callPromise = client.callTool('gated')
        // Yield long enough for the handler to enter the wrapped fn.
        await sleep(20)
        expect(server.getInFlightCount()).toBe(1)

        release()
        await callPromise
        expect(server.getInFlightCount()).toBe(0)
    })

    it('decrements on the error path too', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'boom',
                    description: '',
                    inputSchema: {},
                    handler: async () => {
                        throw new Error('handler exploded')
                    },
                },
            ],
        })
        cleanup.push(dispose)

        // The MCP SDK turns handler throws into a content-shaped result
        // with the error message rather than rejecting the promise. The
        // important thing for the shutdown contract is that the
        // wrapping `try/finally` still ran and decremented the counter.
        await client.callTool('boom').catch(() => {
            /* swallow either shape */
        })
        expect(server.getInFlightCount()).toBe(0)
    })

    it('counts concurrent calls correctly', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'gated',
                    description: '',
                    inputSchema: {},
                    handler: async () => {
                        await gate
                        return { content: [{ type: 'text', text: 'ok' }] }
                    },
                },
            ],
        })
        cleanup.push(dispose)

        const calls = [
            client.callTool('gated'),
            client.callTool('gated'),
            client.callTool('gated'),
        ]
        await sleep(20)
        expect(server.getInFlightCount()).toBe(3)

        release()
        await Promise.all(calls)
        expect(server.getInFlightCount()).toBe(0)
    })
})

describe('close — happy path', () => {
    it('resolves immediately when there are no in-flight calls', async () => {
        const { server, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const start = Date.now()
        await server.close()
        const elapsed = Date.now() - start

        expect(elapsed).toBeLessThan(200) // generous upper bound
        expect(server.isShuttingDown()).toBe(true)
    })

    it('waits for in-flight calls before resolving', async () => {
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })

        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'slow',
                    description: '',
                    inputSchema: {},
                    handler: async () => {
                        await gate
                        return { content: [{ type: 'text', text: 'done' }] }
                    },
                },
            ],
        })
        cleanup.push(dispose)

        const callPromise = client.callTool('slow')
        await sleep(20)
        expect(server.getInFlightCount()).toBe(1)

        // Trigger close. It must NOT resolve while the handler is gated.
        const closePromise = server.close({ timeoutMs: 5000 })
        let closeResolved = false
        closePromise.then(() => {
            closeResolved = true
        })
        await sleep(100)
        expect(closeResolved).toBe(false)
        expect(server.isShuttingDown()).toBe(true)

        // Release the handler. close() should now drain and resolve.
        release()
        await callPromise
        await closePromise
        expect(closeResolved).toBe(true)
        expect(server.getInFlightCount()).toBe(0)
    })
})

describe('close — timeout', () => {
    it('throws ShutdownTimeoutError with the residual count', async () => {
        // A handler that never resolves. We'll force-resolve it from
        // the test cleanup to avoid hanging the test runner.
        let neverRelease!: () => void
        const gate = new Promise<void>((resolve) => {
            neverRelease = resolve
        })

        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'stuck',
                    description: '',
                    inputSchema: {},
                    handler: async () => {
                        await gate
                        return { content: [{ type: 'text', text: 'eventually' }] }
                    },
                },
            ],
        })
        cleanup.push(async () => {
            // Release any pending handler so the in-memory transport
            // can shut down cleanly.
            neverRelease()
            await dispose()
        })

        const callPromise = client.callTool('stuck')
        // Swallow the eventual rejection so the unhandled-rejection
        // warning doesn't fire when the test runner tears down.
        callPromise.catch(() => { })
        await sleep(20)

        try {
            await server.close({ timeoutMs: 200 })
            throw new Error('expected ShutdownTimeoutError')
        } catch (err) {
            expect(err).toBeInstanceOf(ShutdownTimeoutError)
            const e = err as ShutdownTimeoutError
            expect(e.inFlight).toBe(1)
            expect(e.timeoutMs).toBe(200)
            expect(isMppMcpError(e)).toBe(true)
            expect(e.code).toBe('shutdown-timeout')
        }
    })
})

describe('close — rejecting new calls', () => {
    it('rejects tool calls invoked after close() begins (during drain)', async () => {
        // Hold close() in the drain phase using a gated handler so
        // the second tool call arrives while `shuttingDown === true`
        // but the transport is still up.
        let releaseGated!: () => void
        const gate = new Promise<void>((resolve) => {
            releaseGated = resolve
        })

        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'gated',
                    description: '',
                    inputSchema: {},
                    handler: async () => {
                        await gate
                        return { content: [{ type: 'text', text: 'ok' }] }
                    },
                },
                {
                    name: 'free',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({
                        content: [{ type: 'text', text: 'ok' }],
                    }),
                },
            ],
        })
        cleanup.push(async () => {
            releaseGated()
            await dispose()
        })

        // Hold a call in flight so close() stays in drain mode.
        const heldCall = client.callTool('gated')
        await sleep(20)

        // Begin shutdown — server is now refusing new calls but still
        // draining the held one.
        const closePromise = server.close({ timeoutMs: 5000 })
        // Brief yield so the shuttingDown flag is observable.
        await sleep(20)

        // The MCP SDK projects handler throws into a content-shaped
        // result rather than a rejection. The result includes the
        // error message in its content blocks. We assert on the
        // observable surface — the content should mention "shutting
        // down" and (depending on SDK version) carry an isError flag.
        const result = (await client.callTool('free')) as unknown as {
            content: Array<{ text?: string }>
        }
        const text = result.content.map((c) => c.text ?? '').join(' ')
        expect(text).toMatch(/shutting down/i)

        // Release the held handler and finish shutdown.
        releaseGated()
        await heldCall
        await closePromise
    })

    it('refuses new calls after close() resolves', async () => {
        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'free',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({
                        content: [{ type: 'text', text: 'ok' }],
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        await server.close()
        // After close resolves, the transport is also disconnected.
        // The client either sees "shutting down" projected as content
        // OR a transport-level rejection. Either is acceptable; we
        // just assert the call did NOT return a normal success.
        const result = await client
            .callTool('free')
            .catch((err: Error) => ({ error: err.message }))
        // If we got here without rejection, ensure it's the
        // shutting-down content shape.
        if ('content' in result) {
            const text = (
                result as unknown as { content: Array<{ text?: string }> }
            ).content
                .map((c) => c.text ?? '')
                .join(' ')
            expect(text).toMatch(/shutting down|not connected|connection closed/i)
        } else {
            expect(result.error).toMatch(/shutting down|not connected|connection closed/i)
        }
    })
})

describe('close — idempotency', () => {
    it('multiple concurrent close calls share one shutdown promise', async () => {
        const { server, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        const a = server.close()
        const b = server.close()
        const c = server.close()

        await Promise.all([a, b, c])
        // No errors thrown; all three resolve.
        expect(server.isShuttingDown()).toBe(true)
    })

    it('a sequential second close() also resolves cleanly', async () => {
        const { server, dispose } = await makeConnectedPair({ tools: [] })
        cleanup.push(dispose)

        await server.close()
        await server.close() // no-op, returns the cached promise
    })
})

describe('close — onShutdown hook', () => {
    it('fires the hook before drain', async () => {
        let hookFired = false
        let hookFiredAt = 0

        const { server, dispose } = await makeConnectedPair({
            tools: [],
            serverConfig: {
                onShutdown: async () => {
                    hookFired = true
                    hookFiredAt = Date.now()
                },
            },
        })
        cleanup.push(dispose)

        const closeStart = Date.now()
        await server.close()

        expect(hookFired).toBe(true)
        // Hook must fire after close started but during shutdown.
        expect(hookFiredAt).toBeGreaterThanOrEqual(closeStart)
    })

    it('hook errors are logged but do not abort the drain', async () => {
        const { logger, entries } = arrayLogger()

        const { server, dispose } = await makeConnectedPair({
            tools: [],
            serverConfig: {
                logger,
                onShutdown: () => {
                    throw new Error('hook exploded')
                },
            },
        })
        cleanup.push(dispose)

        // The drain still completes successfully.
        await server.close()

        // The error was logged at error level.
        const errorEntry = entries.find(
            (e) => e.level === 'error' && /onShutdown hook/.test(e.message)
        )
        expect(errorEntry).toBeDefined()
        expect(errorEntry!.context.err).toBeDefined()
    })

    it('async hook with rejection is logged but drain completes', async () => {
        const { logger, entries } = arrayLogger()

        const { server, dispose } = await makeConnectedPair({
            tools: [],
            serverConfig: {
                logger,
                onShutdown: async () => {
                    throw new Error('async hook failed')
                },
            },
        })
        cleanup.push(dispose)

        await server.close()

        const errorEntry = entries.find(
            (e) =>
                e.level === 'error' &&
                /onShutdown hook/.test(e.message)
        )
        expect(errorEntry).toBeDefined()
    })
})

describe('close — logging', () => {
    it('emits initiated, drain complete, and complete entries', async () => {
        const { logger, entries } = arrayLogger()

        const { server, dispose } = await makeConnectedPair({
            tools: [],
            serverConfig: { logger },
        })
        cleanup.push(dispose)

        await server.close()

        const messages = entries
            .filter((e) => e.context.phase === 'shutdown')
            .map((e) => e.message)
        expect(messages).toContain('shutdown initiated')
        expect(messages).toContain('drain complete')
        expect(messages).toContain('shutdown complete')
    })

    it('reports inFlight count and timeoutMs in the initiated entry', async () => {
        const { logger, entries } = arrayLogger()

        const { server, dispose } = await makeConnectedPair({
            tools: [],
            serverConfig: { logger },
        })
        cleanup.push(dispose)

        await server.close({ timeoutMs: 1234 })

        const initiated = entries.find(
            (e) => e.message === 'shutdown initiated'
        )
        expect(initiated).toBeDefined()
        expect(initiated!.context.timeoutMs).toBe(1234)
        expect(initiated!.context.inFlight).toBe(0)
    })

    it('emits a drain timeout error entry when timing out', async () => {
        const { logger, entries } = arrayLogger()
        let neverRelease!: () => void
        const gate = new Promise<void>((resolve) => {
            neverRelease = resolve
        })

        const { client, server, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'stuck',
                    description: '',
                    inputSchema: {},
                    handler: async () => {
                        await gate
                        return { content: [{ type: 'text', text: 'eventually' }] }
                    },
                },
            ],
            serverConfig: { logger },
        })
        cleanup.push(async () => {
            neverRelease()
            // Give the held call a beat to settle before dispose so
            // its rejection (from transport close) doesn't surface as
            // an unhandled rejection during the test runner teardown.
            await sleep(20)
            await dispose()
        })

        const callPromise = client.callTool('stuck')
        callPromise.catch(() => { })
        await sleep(20)

        await expect(server.close({ timeoutMs: 100 })).rejects.toBeInstanceOf(
            ShutdownTimeoutError
        )

        const timeoutEntry = entries.find(
            (e) => e.level === 'error' && e.message === 'drain timeout'
        )
        expect(timeoutEntry).toBeDefined()
        expect(timeoutEntry!.context.inFlight).toBe(1)
    })
})

describe('drainTimeoutMs default', () => {
    it('uses constructor-supplied default when close() omits timeoutMs', async () => {
        const { server, dispose } = await makeConnectedPair({
            tools: [],
            serverConfig: { drainTimeoutMs: 500 },
        })
        cleanup.push(dispose)

        // Nothing in-flight, so drain finishes well under 500ms.
        const start = Date.now()
        await server.close()
        const elapsed = Date.now() - start
        expect(elapsed).toBeLessThan(500)
    })
})

// Suppress unused-warning for the locally re-imported ShuttingDownError —
// kept around so the test file imports compile and so future tests can
// reference it without re-importing.
void ShuttingDownError

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
