/**
 * Tests for OpenTelemetry tracing integration.
 *
 * What we verify:
 *
 *   1. With no tracer configured, tracing helpers are pure no-ops
 *      (no allocations, no observable behavior change).
 *   2. With a tracer configured, free / per-call / access-key paths
 *      produce the expected span tree.
 *   3. Span attributes are populated correctly per pricing path.
 *   4. Span status reflects success vs failure (and 402 challenges
 *      are NOT marked as ERROR).
 *
 * We use a hand-built capturing tracer rather than spinning up a
 * real OTel SDK. The OTel API is stable; what we're testing is our
 * own instrumentation, not the SDK's correctness. The capturing
 * tracer implements the minimal subset of the Tracer interface our
 * shim consumes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
    SPAN_STATUS,
    startSpan,
    TRACE_ATTRS,
    TRACE_SPANS,
} from '../src/tracing.js'
import type { ActiveSpan } from '../src/tracing.js'
import { makeConnectedPair } from './helpers.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

/**
 * A captured span snapshot. We don't replicate OTel's full Span
 * surface — only the fields our instrumentation actually touches.
 */
interface CapturedSpan {
    name: string
    attributes: Record<string, string | number | boolean>
    status: { code: number; message?: string } | null
    exceptions: unknown[]
    ended: boolean
    endedAt: number | null
}

/**
 * Build a tracer that records every span into an in-memory array.
 * Returns the tracer and the snapshot list. The shape mirrors
 * `@opentelemetry/api`'s Tracer + Span enough to satisfy our
 * `wrapSpan` helper.
 */
function makeCapturingTracer() {
    const spans: CapturedSpan[] = []

    const tracer = {
        startSpan(
            name: string,
            options?: {
                attributes?: Record<string, string | number | boolean>
            }
        ) {
            const captured: CapturedSpan = {
                name,
                attributes: { ...(options?.attributes ?? {}) },
                status: null,
                exceptions: [],
                ended: false,
                endedAt: null,
            }
            spans.push(captured)

            // Return a shape close enough to OTel's Span for our
            // wrapper. wrapSpan calls setAttribute, recordException,
            // setStatus, and end — that's the full surface.
            return {
                setAttribute(key: string, value: string | number | boolean) {
                    captured.attributes[key] = value
                    return this
                },
                recordException(err: unknown) {
                    captured.exceptions.push(err)
                    return this
                },
                setStatus(status: { code: number; message?: string }) {
                    captured.status = status
                    return this
                },
                end() {
                    captured.ended = true
                    captured.endedAt = Date.now()
                },
            }
        },
    } as unknown as Parameters<typeof startSpan>[0]

    return { tracer, spans }
}

// -------------------------------------------------------------------
// No-tracer behavior
// -------------------------------------------------------------------

describe('tracing — no tracer configured', () => {
    it('startSpan returns a no-op span when tracer is undefined', () => {
        const span: ActiveSpan = startSpan(undefined, 'mppmcp.test', {
            foo: 'bar',
        })
        // Methods exist and don't throw.
        expect(typeof span.setAttribute).toBe('function')
        span.setAttribute('k', 'v')
        span.recordException(new Error('x'))
        span.setError(new Error('x'))
        span.setOk()
        span.end()
        // Calling end twice on a no-op is also fine.
        span.end()
    })

    it('the server runs normally when no tracer is configured', async () => {
        // Sanity check: the test fixture defaults to no tracer, so
        // the entire 282-test baseline already proves this. Add an
        // explicit assertion here so the contract is named.
        const { client, dispose } = await makeConnectedPair({
            tools: [
                {
                    name: 'echo',
                    description: '',
                    inputSchema: { msg: z.string() },
                    handler: async ({ msg }) => ({
                        content: [{ type: 'text', text: String(msg) }],
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        const result = (await client.callTool('echo', {
            msg: 'hi',
        })) as unknown as { content: Array<{ text?: string }> }
        expect(result.content[0]?.text).toBe('hi')
    })
})

// -------------------------------------------------------------------
// Span tree per pricing path
// -------------------------------------------------------------------

describe('tracing — span tree shape', () => {
    it('emits root + handler.run spans for a free tool', async () => {
        const { tracer, spans } = makeCapturingTracer()

        const { client, dispose } = await makeConnectedPair({
            serverConfig: { tracer },
            tools: [
                {
                    name: 'free_echo',
                    description: '',
                    inputSchema: { msg: z.string() },
                    handler: async ({ msg }) => ({
                        content: [{ type: 'text', text: String(msg) }],
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        await client.callTool('free_echo', { msg: 'hello' })

        // Find the spans we expect by name.
        const root = spans.find((s) => s.name === TRACE_SPANS.TOOL_CALL)
        const handler = spans.find((s) => s.name === TRACE_SPANS.HANDLER_RUN)

        expect(root).toBeTruthy()
        expect(handler).toBeTruthy()
        expect(root!.ended).toBe(true)
        expect(handler!.ended).toBe(true)

        // Root span carries tool name and pricing type.
        expect(root!.attributes[TRACE_ATTRS.TOOL_NAME]).toBe('free_echo')
        expect(root!.attributes[TRACE_ATTRS.PRICING_TYPE]).toBe('free')
        expect(root!.attributes[TRACE_ATTRS.PAYMENT_MODE]).toBe('free')

        // Both spans completed with OK status (code = 1).
        expect(root!.status?.code).toBe(SPAN_STATUS.OK)
        expect(handler!.status?.code).toBe(SPAN_STATUS.OK)

        // No payment-charge span on a free path.
        expect(
            spans.find((s) => s.name === TRACE_SPANS.PAYMENT_CHARGE)
        ).toBeUndefined()
    })

    it('emits payment-charge child span on a paid path 402', async () => {
        // We can't drive a successful paid call without testnet
        // funds. We CAN observe that a 402 challenge produces the
        // expected span shape.
        const { tracer, spans } = makeCapturingTracer()

        const { client, dispose } = await makeConnectedPair({
            clientConfig: {
                // Block before signing so the 402 surfaces cleanly.
                maxPerCall: '0.0001',
                maxTotal: '0.0001',
            },
            serverConfig: { tracer },
            tools: [
                {
                    name: 'paid_echo',
                    description: '',
                    inputSchema: { msg: z.string() },
                    pricing: { type: 'per-call', amount: '0.001' },
                    handler: async ({ msg }) => ({
                        content: [{ type: 'text', text: String(msg) }],
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        // The cap exceeds before signing; the server still emits a
        // 402 challenge first, which is what produces the spans.
        await client.callTool('paid_echo', { msg: 'x' }).catch(() => {
            /* SpendingCapExceededError on the client side is fine */
        })

        const root = spans.find((s) => s.name === TRACE_SPANS.TOOL_CALL)
        const charge = spans.find((s) => s.name === TRACE_SPANS.PAYMENT_CHARGE)

        expect(root).toBeTruthy()
        expect(charge).toBeTruthy()
        expect(root!.attributes[TRACE_ATTRS.PRICING_TYPE]).toBe('per-call')
        expect(root!.attributes[TRACE_ATTRS.AMOUNT]).toBe('0.001')

        // 402 challenges are control flow, not failure. Both spans
        // should end with OK status, with a hint attribute carrying
        // the outcome.
        expect(root!.status?.code).toBe(SPAN_STATUS.OK)
        expect(root!.attributes['mppmcp.outcome']).toBe('payment-required')
        expect(charge!.status?.code).toBe(SPAN_STATUS.OK)
        expect(charge!.attributes['mppmcp.outcome']).toBe('payment-required')
    })

    it('marks root span ERROR when the user handler throws', async () => {
        const { tracer, spans } = makeCapturingTracer()

        const { client, dispose } = await makeConnectedPair({
            serverConfig: { tracer },
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

        // The MCP SDK projects handler throws into a content-shaped
        // result, so there's no rejection on the client side. The
        // span on the server side records ERROR regardless.
        await client.callTool('boom').catch(() => {
            /* either shape is fine */
        })

        const root = spans.find((s) => s.name === TRACE_SPANS.TOOL_CALL)
        const handler = spans.find((s) => s.name === TRACE_SPANS.HANDLER_RUN)

        expect(root).toBeTruthy()
        expect(handler).toBeTruthy()

        // Both the user-handler span AND the root span should be
        // ERROR (code = 2). The thrown error propagates from the
        // handler span up to the root.
        expect(handler!.status?.code).toBe(SPAN_STATUS.ERROR)
        expect(root!.status?.code).toBe(SPAN_STATUS.ERROR)
        expect(handler!.exceptions.length).toBeGreaterThan(0)
    })
})

// -------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------

describe('tracing — span lifecycle', () => {
    it('every span is ended after the call completes', async () => {
        const { tracer, spans } = makeCapturingTracer()

        const { client, dispose } = await makeConnectedPair({
            serverConfig: { tracer },
            tools: [
                {
                    name: 'noop',
                    description: '',
                    inputSchema: {},
                    handler: async () => ({
                        content: [{ type: 'text', text: 'ok' }],
                    }),
                },
            ],
        })
        cleanup.push(dispose)

        await client.callTool('noop')
        await client.callTool('noop')

        // Every captured span should be marked ended.
        for (const s of spans) {
            expect(s.ended).toBe(true)
            expect(s.endedAt).toBeTruthy()
        }
    })

    it('root span ends even when an internal phase throws', async () => {
        const { tracer, spans } = makeCapturingTracer()

        const { client, dispose } = await makeConnectedPair({
            serverConfig: { tracer },
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

        await client.callTool('boom').catch(() => { })

        const root = spans.find((s) => s.name === TRACE_SPANS.TOOL_CALL)
        expect(root).toBeTruthy()
        expect(root!.ended).toBe(true)
    })
})
