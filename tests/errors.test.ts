/**
 * Tests for the error taxonomy.
 *
 * The behavior we're pinning:
 *   1. Every library error is `instanceof MppMcpError`.
 *   2. Each subclass exposes a stable `code` field for programmatic
 *      handling without depending on message text.
 *   3. `cause` is preserved when an error wraps a lower-level failure.
 *   4. The pre-existing `SpendingCapExceededError` and
 *      `SessionDepositCapExceededError` continue to expose their
 *      original fields (`kind`, `requested`, `limit`, etc.) — public
 *      API is backward compatible.
 *   5. `isMppMcpError` correctly distinguishes library errors from
 *      arbitrary `Error` instances.
 *   6. The errors are throwable from real flows — we exercise the
 *      `ConfigurationError` path via the client constructor and the
 *      `ValidationError` path via the amount helpers.
 */

import { describe, expect, it } from 'vitest'

import {
    parseDuration,
    validateAccessKeyPricing,
} from '../src/access-keys.js'
import { usdStringToBaseUnits } from '../src/amounts.js'
import {
    ConfigurationError,
    InternalError,
    isMppMcpError,
    MppMcpError,
    SessionDepositCapExceededError,
    SpendingCapExceededError,
    StoreError,
    ValidationError,
    createPaidMcpClient,
} from '../src/index.js'
import { TEST_AGENT_KEY } from './helpers.js'

describe('MppMcpError base contract', () => {
    it('every concrete subclass extends MppMcpError', () => {
        const cases: MppMcpError[] = [
            new ConfigurationError('x'),
            new ValidationError('x'),
            new InternalError('x'),
            new StoreError({ kind: 'backend-error', message: 'x' }),
            new SpendingCapExceededError({
                kind: 'per-call',
                requested: 1,
                limit: 0.5,
            }),
            new SessionDepositCapExceededError({ suggested: 5, limit: 1 }),
        ]
        for (const e of cases) {
            expect(e).toBeInstanceOf(MppMcpError)
            expect(e).toBeInstanceOf(Error)
            expect(typeof e.code).toBe('string')
            expect(e.code.length).toBeGreaterThan(0)
        }
    })

    it('sets a non-default `name` matching the class name', () => {
        expect(new ConfigurationError('x').name).toBe('ConfigurationError')
        expect(new ValidationError('x').name).toBe('ValidationError')
        expect(new InternalError('x').name).toBe('InternalError')
        expect(
            new StoreError({ kind: 'backend-error', message: 'x' }).name
        ).toBe('StoreError')
    })

    it('preserves `cause` when constructed with one', () => {
        const root = new Error('root cause')
        const wrapped = new StoreError({
            kind: 'backend-error',
            message: 'wrapped',
            cause: root,
        })
        expect(wrapped.cause).toBe(root)
    })

    it('omits `cause` when not provided', () => {
        const e = new ValidationError('no cause here')
        expect(e.cause).toBeUndefined()
    })
})

describe('isMppMcpError', () => {
    it('returns true for library errors', () => {
        expect(isMppMcpError(new ConfigurationError('x'))).toBe(true)
        expect(
            isMppMcpError(
                new SpendingCapExceededError({
                    kind: 'per-call',
                    requested: 1,
                    limit: 0.5,
                })
            )
        ).toBe(true)
    })

    it('returns false for plain Error and arbitrary values', () => {
        expect(isMppMcpError(new Error('plain'))).toBe(false)
        expect(isMppMcpError(new TypeError('typed'))).toBe(false)
        expect(isMppMcpError({ message: 'duck' })).toBe(false)
        expect(isMppMcpError(null)).toBe(false)
        expect(isMppMcpError(undefined)).toBe(false)
        expect(isMppMcpError('string error')).toBe(false)
    })
})

describe('error codes are stable identifiers', () => {
    it('ConfigurationError → invalid-config', () => {
        expect(new ConfigurationError('x').code).toBe('invalid-config')
    })
    it('ValidationError → invalid-input', () => {
        expect(new ValidationError('x').code).toBe('invalid-input')
    })
    it('InternalError → internal', () => {
        expect(new InternalError('x').code).toBe('internal')
    })
    it('StoreError code mirrors kind for backend-error / cas-exhausted', () => {
        expect(
            new StoreError({ kind: 'backend-error', message: 'x' }).code
        ).toBe('store-backend-error')
        expect(
            new StoreError({ kind: 'invalid-value', message: 'x' }).code
        ).toBe('store-invalid-value')
        expect(
            new StoreError({ kind: 'cas-exhausted', message: 'x' }).code
        ).toBe('cas-exhausted')
    })
    it('SpendingCapExceededError → cap-exceeded', () => {
        const e = new SpendingCapExceededError({
            kind: 'per-call',
            requested: 1,
            limit: 0.5,
        })
        expect(e.code).toBe('cap-exceeded')
    })
    it('SessionDepositCapExceededError → session-deposit-cap-exceeded', () => {
        const e = new SessionDepositCapExceededError({ suggested: 5, limit: 1 })
        expect(e.code).toBe('session-deposit-cap-exceeded')
    })
})

describe('integration with throw sites', () => {
    it('client constructor throws ConfigurationError for non-positive caps', () => {
        expect.assertions(3)
        try {
            createPaidMcpClient({
                name: 'x',
                version: '0',
                privateKey: TEST_AGENT_KEY,
                maxPerCall: '-1',
            })
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigurationError)
            expect(isMppMcpError(err)).toBe(true)
            expect((err as ConfigurationError).code).toBe('invalid-config')
        }
    })

    it('usdStringToBaseUnits throws ValidationError on malformed input', () => {
        expect.assertions(3)
        try {
            usdStringToBaseUnits('not a number')
        } catch (err) {
            expect(err).toBeInstanceOf(ValidationError)
            expect(isMppMcpError(err)).toBe(true)
            expect((err as ValidationError).code).toBe('invalid-input')
        }
    })

    it('parseDuration throws ValidationError on bad format', () => {
        try {
            parseDuration('not a duration')
        } catch (err) {
            expect(err).toBeInstanceOf(ValidationError)
        }
    })

    it('validateAccessKeyPricing throws ConfigurationError when no bound is set', () => {
        try {
            validateAccessKeyPricing('t', { type: 'access-key', amount: '1' })
        } catch (err) {
            expect(err).toBeInstanceOf(ConfigurationError)
        }
    })
})

describe('SpendingCapExceededError shape (back-compat)', () => {
    it('exposes kind / requested / limit / totalSpent', () => {
        const e = new SpendingCapExceededError({
            kind: 'total',
            requested: 0.5,
            limit: 5,
            totalSpent: 4.6,
        })
        expect(e.kind).toBe('total')
        expect(e.requested).toBe(0.5)
        expect(e.limit).toBe(5)
        expect(e.totalSpent).toBe(4.6)
        expect(e.message).toContain('5.10')
    })

    it('per-call form omits totalSpent in message', () => {
        const e = new SpendingCapExceededError({
            kind: 'per-call',
            requested: 1,
            limit: 0.5,
        })
        expect(e.totalSpent).toBeUndefined()
        expect(e.message).toContain('exceeds maxPerCall cap')
    })
})

describe('SessionDepositCapExceededError shape (back-compat)', () => {
    it('exposes suggested / limit', () => {
        const e = new SessionDepositCapExceededError({
            suggested: 5,
            limit: 1,
        })
        expect(e.suggested).toBe(5)
        expect(e.limit).toBe(1)
        expect(e.message).toContain('Raise maxSessionDeposit')
    })
})
