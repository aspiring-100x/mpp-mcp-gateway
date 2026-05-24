/**
 * Tests for the structured logger module.
 *
 * Five surfaces under test:
 *
 *   1. `consoleLogger` — level filtering, JSON shape, child bindings,
 *      pretty mode, custom write sinks.
 *   2. `silentLogger` — discards everything.
 *   3. `arrayLogger` — captures entries with merged bindings.
 *   4. `withRedaction` — scrubs sensitive fields, handles nesting,
 *      cycles, custom field lists, and value-pattern matching.
 *   5. Integration with `MppMcpError` — codes, causes, recursive
 *      cause chains.
 */

import { describe, expect, it } from 'vitest'

import {
    ConfigurationError,
    StoreError,
} from '../src/errors.js'
import {
    arrayLogger,
    consoleLogger,
    defaultLogger,
    silentLogger,
    withRedaction,
} from '../src/logger.js'

/** Capture console output to a string array via a custom write sink. */
function makeBuffer() {
    const lines: string[] = []
    return {
        lines,
        write: (line: string) => {
            lines.push(line)
        },
    }
}

function parseEntry(line: string): Record<string, unknown> {
    return JSON.parse(line) as Record<string, unknown>
}

describe('consoleLogger', () => {
    it('emits structured JSON with the standard fields', () => {
        const buf = makeBuffer()
        const log = consoleLogger({ write: buf.write, level: 'debug' })

        log.info('hello', { foo: 'bar' })

        expect(buf.lines).toHaveLength(1)
        const entry = parseEntry(buf.lines[0]!)
        expect(entry.level).toBe('info')
        expect(entry.message).toBe('hello')
        expect(entry.foo).toBe('bar')
        expect(typeof entry.time).toBe('string')
    })

    it('filters entries below the configured level', () => {
        const buf = makeBuffer()
        const log = consoleLogger({ write: buf.write, level: 'warn' })

        log.debug('skipped')
        log.info('also skipped')
        log.warn('kept')
        log.error('also kept')

        expect(buf.lines).toHaveLength(2)
        expect(parseEntry(buf.lines[0]!).message).toBe('kept')
        expect(parseEntry(buf.lines[1]!).message).toBe('also kept')
    })

    it('default level is info', () => {
        const buf = makeBuffer()
        const log = consoleLogger({ write: buf.write })

        log.debug('dropped')
        log.info('kept')

        expect(buf.lines).toHaveLength(1)
    })

    it('child bindings merge into every entry from the child', () => {
        const buf = makeBuffer()
        const parent = consoleLogger({ write: buf.write })
        const child = parent.child({ tool: 'get_weather' })

        parent.info('parent log')
        child.info('child log')
        child.info('child override', { tool: 'get_forecast' })

        const entries = buf.lines.map(parseEntry)
        expect(entries[0]!.tool).toBeUndefined()
        expect(entries[1]!.tool).toBe('get_weather')
        // Per-call context overrides bindings at the same key.
        expect(entries[2]!.tool).toBe('get_forecast')
    })

    it('child does not mutate the parent', () => {
        const buf = makeBuffer()
        const parent = consoleLogger({ write: buf.write })
        const child = parent.child({ scope: 'child' })

        child.info('from child')
        parent.info('from parent')

        const entries = buf.lines.map(parseEntry)
        expect(entries[0]!.scope).toBe('child')
        expect(entries[1]!.scope).toBeUndefined()
    })

    it('pretty mode produces a non-JSON line', () => {
        const buf = makeBuffer()
        const log = consoleLogger({
            write: buf.write,
            pretty: true,
            level: 'debug',
        })

        log.info('hi', { foo: 'bar' })

        expect(buf.lines).toHaveLength(1)
        const line = buf.lines[0]!
        expect(line).toContain('INFO')
        expect(line).toContain('hi')
        // Should NOT be parseable as JSON in pretty mode.
        expect(() => JSON.parse(line)).toThrow()
    })

    it('serializes Error context fields with name and message', () => {
        const buf = makeBuffer()
        const log = consoleLogger({ write: buf.write })

        log.error('something failed', { err: new Error('boom') })

        const entry = parseEntry(buf.lines[0]!)
        const err = entry.err as Record<string, unknown>
        expect(err.name).toBe('Error')
        expect(err.message).toBe('boom')
        expect(typeof err.stack).toBe('string')
    })

    it('serializes MppMcpError with code and recursive cause', () => {
        const buf = makeBuffer()
        const log = consoleLogger({ write: buf.write })

        const root = new Error('network timeout')
        const wrapped = new StoreError({
            kind: 'backend-error',
            message: 'redis call failed',
            cause: root,
        })

        log.error('store failure', { err: wrapped })

        const entry = parseEntry(buf.lines[0]!)
        const err = entry.err as Record<string, unknown>
        expect(err.name).toBe('StoreError')
        expect(err.code).toBe('store-backend-error')
        expect(err.message).toBe('redis call failed')
        const cause = err.cause as Record<string, unknown>
        expect(cause.name).toBe('Error')
        expect(cause.message).toBe('network timeout')
    })
})

describe('silentLogger', () => {
    it('discards every call', () => {
        const log = silentLogger()
        log.debug('x')
        log.info('x')
        log.warn('x')
        log.error('x')
        log.child({ scope: 'a' }).error('x')
        // No assertion needed — just verifying no throw and no output.
        expect(true).toBe(true)
    })

    it('child returns a logger of the same shape', () => {
        const log = silentLogger()
        const child = log.child({ tool: 'a' })
        expect(typeof child.info).toBe('function')
        expect(typeof child.child).toBe('function')
    })
})

describe('arrayLogger', () => {
    it('captures entries with their level and message', () => {
        const { logger, entries } = arrayLogger()
        logger.info('one', { a: 1 })
        logger.warn('two')
        logger.error('three', { e: new Error('oops') })

        expect(entries).toHaveLength(3)
        expect(entries[0]).toMatchObject({
            level: 'info',
            message: 'one',
            context: { a: 1 },
        })
        expect(entries[1]).toMatchObject({ level: 'warn', message: 'two' })
        expect(entries[2]!.context.e).toBeInstanceOf(Error)
    })

    it('child bindings flow into captured context', () => {
        const { logger, entries } = arrayLogger()
        logger.info('parent')
        const child = logger.child({ tool: 'x' })
        child.warn('from child', { extra: 1 })

        expect(entries[0]!.context).toEqual({})
        expect(entries[1]!.context).toEqual({ tool: 'x', extra: 1 })
    })

    it('per-call context overrides child bindings at conflicting keys', () => {
        const { logger, entries } = arrayLogger()
        logger.child({ tool: 'a' }).info('msg', { tool: 'b' })

        expect(entries[0]!.context).toEqual({ tool: 'b' })
    })
})

describe('withRedaction', () => {
    it('scrubs default sensitive field names case-insensitively', () => {
        const buf = makeBuffer()
        const log = withRedaction(consoleLogger({ write: buf.write }))

        log.info('config dump', {
            secretKey: 'sk_live_1',
            PrivateKey: '0xabc',
            FeePayerKey: '0xdef',
            normal: 'visible',
        })

        const entry = parseEntry(buf.lines[0]!)
        expect(entry.secretKey).toBe('[REDACTED]')
        expect(entry.PrivateKey).toBe('[REDACTED]')
        expect(entry.FeePayerKey).toBe('[REDACTED]')
        expect(entry.normal).toBe('visible')
    })

    it('redacts recursively at any depth', () => {
        const buf = makeBuffer()
        const log = withRedaction(consoleLogger({ write: buf.write }))

        log.info('nested', {
            outer: {
                middle: {
                    secretKey: 'leak-me',
                    safe: 'visible',
                },
            },
        })

        const entry = parseEntry(buf.lines[0]!)
        const middle = (entry.outer as Record<string, unknown>)
            .middle as Record<string, unknown>
        expect(middle.secretKey).toBe('[REDACTED]')
        expect(middle.safe).toBe('visible')
    })

    it('redacts inside arrays of objects', () => {
        const buf = makeBuffer()
        const log = withRedaction(consoleLogger({ write: buf.write }))

        log.info('array context', {
            keys: [
                { secretKey: 'a' },
                { secretKey: 'b', label: 'visible' },
            ],
        })

        const entry = parseEntry(buf.lines[0]!)
        const arr = entry.keys as Array<Record<string, unknown>>
        expect(arr[0]!.secretKey).toBe('[REDACTED]')
        expect(arr[1]!.secretKey).toBe('[REDACTED]')
        expect(arr[1]!.label).toBe('visible')
    })

    it('redacts long hex blobs (signed transactions) by value pattern', () => {
        const buf = makeBuffer()
        const log = withRedaction(consoleLogger({ write: buf.write }))

        const longHex = '0x' + 'a'.repeat(300)
        const shortHex = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // wallet
        log.info('tx event', { signedTx: longHex, recipient: shortHex })

        const entry = parseEntry(buf.lines[0]!)
        // signedTx field name is also in the default field list, so it
        // gets redacted by name regardless. Test the value pattern by
        // putting it under a non-listed key.
        log.info('raw blob', { blob: longHex, address: shortHex })

        const second = parseEntry(buf.lines[1]!)
        expect(second.blob).toBe('[REDACTED]')
        expect(second.address).toBe(shortHex) // wallet addresses preserved
    })

    it('honors custom field list', () => {
        const buf = makeBuffer()
        const log = withRedaction(consoleLogger({ write: buf.write }), {
            fields: ['apiKey', 'webhookSecret'],
        })

        log.info('custom redact', {
            apiKey: 'leak',
            webhookSecret: 'leak',
            secretKey: 'NOT-redacted-with-custom-list', // fields are replaced wholesale
        })

        const entry = parseEntry(buf.lines[0]!)
        expect(entry.apiKey).toBe('[REDACTED]')
        expect(entry.webhookSecret).toBe('[REDACTED]')
        // With custom list replacing defaults, 'secretKey' is no longer redacted.
        expect(entry.secretKey).toBe('NOT-redacted-with-custom-list')
    })

    it('honors custom placeholder', () => {
        const buf = makeBuffer()
        const log = withRedaction(consoleLogger({ write: buf.write }), {
            placeholder: '<hidden>',
        })

        log.info('msg', { secretKey: 'leak' })

        const entry = parseEntry(buf.lines[0]!)
        expect(entry.secretKey).toBe('<hidden>')
    })

    it('handles cycles without infinite recursion', () => {
        const buf = makeBuffer()
        const log = withRedaction(consoleLogger({ write: buf.write }))

        const a: Record<string, unknown> = { name: 'a' }
        const b: Record<string, unknown> = { name: 'b', parent: a }
        a.child = b // cycle

        log.info('cyclic', { graph: a })

        // No throw — entry was emitted successfully.
        expect(buf.lines).toHaveLength(1)
        const entry = parseEntry(buf.lines[0]!)
        const graph = entry.graph as Record<string, unknown>
        const child = graph.child as Record<string, unknown>
        expect(child.parent).toBe('[Circular]')
    })

    it('passes through Error instances unchanged', () => {
        const buf = makeBuffer()
        const log = withRedaction(consoleLogger({ write: buf.write }))

        const err = new ConfigurationError('bad config')
        log.error('failure', { err })

        const entry = parseEntry(buf.lines[0]!)
        const errOut = entry.err as Record<string, unknown>
        expect(errOut.name).toBe('ConfigurationError')
        expect(errOut.code).toBe('invalid-config')
    })

    it('child loggers inherit redaction', () => {
        const buf = makeBuffer()
        const log = withRedaction(consoleLogger({ write: buf.write }))
        const child = log.child({ tool: 'x' })

        child.info('child log', { secretKey: 'leak' })

        const entry = parseEntry(buf.lines[0]!)
        expect(entry.secretKey).toBe('[REDACTED]')
        expect(entry.tool).toBe('x')
    })
})

describe('defaultLogger', () => {
    it('produces a logger with redaction baked in', () => {
        const log = defaultLogger()
        // Smoke test only — actual content goes to stderr. We just
        // verify the construction and the interface shape.
        expect(typeof log.info).toBe('function')
        expect(typeof log.warn).toBe('function')
        expect(typeof log.error).toBe('function')
        expect(typeof log.child).toBe('function')
    })
})
