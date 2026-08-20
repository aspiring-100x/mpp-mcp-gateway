/**
 * Regression tests for wallet-bound access keys (GitHub issue #1,
 * finding MCP-GATEWAY-001).
 *
 * The bug: under `accessKeyBinding: 'wallet'` the server passed
 * `boundTo: readPayerAddress(extra)` to `issueRecord`, and both sides of
 * that handshake failed open. `readPayerAddress` returned `undefined`
 * whenever the payer couldn't be read off the payment credential,
 * `issueRecord` dropped the field when falsy, and `redeem` only enforced
 * binding `if (record.boundTo)`. Net effect: a key issued under
 * `'wallet'` could silently come out as a bearer token that any holder
 * could replay — the server was configured for binding and quietly
 * served something weaker.
 *
 * These tests pin the fail-closed behavior at all three layers:
 * issuance (`issueRecord`), redemption (`redeem`), and the server's
 * pay-and-issue flow (`runAccessKey`).
 *
 * No network: every case here either exercises the pure access-keys
 * module or stops on a guard that runs before `mppx.charge` is reached.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
    issueRecord,
    normalizeWalletAddress,
    redeem,
    storeRecord,
    type AccessKeyRecord,
} from '../src/access-keys.js'
import { InternalError, ValidationError } from '../src/errors.js'
import { arrayLogger, type ArrayLogEntry } from '../src/logger.js'
import { createPaidMcpServer, type PaidMcpServer } from '../src/server.js'
import { createMemoryStore } from '../src/stores/index.js'
import { startSpan, type ActiveSpan } from '../src/tracing.js'
import type { PaidToolDefinition } from '../src/types.js'

const RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
/** mppx requires >= 32 bytes of secret. */
const SECRET = 'access-key-binding-regression-test-secret'

/** EIP-55 checksummed form, as viem hands it to the client. */
const PAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
/** Same address, lowercased — as a credential may carry it. */
const PAYER_LOWER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
/** A different wallet: the thief replaying an intercepted key. */
const ATTACKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const CREDENTIAL_META = 'org.paymentauth/credential'

const PRICING = { type: 'access-key', amount: '0.001', maxCalls: 5 } as const

/** A no-op span — `startSpan` returns one when no tracer is configured. */
const NOOP_SPAN: ActiveSpan = startSpan(undefined, 'test')

type Extra = Record<string, unknown> & { _meta?: Record<string, unknown> }

/** Reach the private members under test, as other suites here do. */
function asInternal(server: PaidMcpServer): {
    resolveKeyBinding(
        extra: Extra,
        toolName: string,
        phase: 'pre-charge' | 'post-charge'
    ): string | undefined
    runAccessKey(
        tool: PaidToolDefinition,
        args: Record<string, unknown>,
        extra: Extra,
        start: number,
        rootSpan: ActiveSpan
    ): Promise<unknown>
} {
    return server as unknown as ReturnType<typeof asInternal>
}

// -------------------------------------------------------------------
// Layer 1 — issuance
// -------------------------------------------------------------------

describe('issueRecord under wallet binding', () => {
    it('refuses to mint a key when the payer address is missing', () => {
        // The heart of issue #1: this used to return a perfectly usable
        // bearer key instead of throwing.
        expect(() =>
            issueRecord({ toolName: 'gated', pricing: PRICING, binding: 'wallet' })
        ).toThrow(InternalError)
        expect(() =>
            issueRecord({ toolName: 'gated', pricing: PRICING, binding: 'wallet' })
        ).toThrow(/Refusing to issue an access key/)
    })

    it('refuses to mint a key bound to a malformed address', () => {
        // Binding to garbage is as bad as not binding: nothing can ever
        // match it, or worse, a truncated value matches too much.
        for (const bad of ['', '0x', 'not-an-address', '0xf39Fd6e5', PAYER + 'ff']) {
            expect(() =>
                issueRecord({
                    toolName: 'gated',
                    pricing: PRICING,
                    binding: 'wallet',
                    boundTo: bad,
                })
            ).toThrow(InternalError)
        }
    })

    it('mints a bound key when the payer is known, normalizing the address', () => {
        const record = issueRecord({
            toolName: 'gated',
            pricing: PRICING,
            binding: 'wallet',
            boundTo: PAYER,
        })
        expect(record.boundTo).toBe(PAYER_LOWER)
        expect(record.key).toMatch(/^mppmcp_[0-9a-f]{64}$/)
    })

    it('still mints bearer keys when binding is off (backward compat)', () => {
        const record = issueRecord({ toolName: 'gated', pricing: PRICING })
        expect(record.boundTo).toBeUndefined()

        const explicit = issueRecord({
            toolName: 'gated',
            pricing: PRICING,
            binding: 'none',
        })
        expect(explicit.boundTo).toBeUndefined()
    })
})

// -------------------------------------------------------------------
// Layer 2 — redemption
// -------------------------------------------------------------------

describe('redeem under wallet binding', () => {
    /** Store a record verbatim, bypassing issueRecord's guards. */
    async function seed(record: AccessKeyRecord) {
        const store = createMemoryStore()
        await storeRecord(store, record)
        return store
    }

    function bearerRecord(): AccessKeyRecord {
        // What a pre-fix server minted when payer extraction failed.
        return issueRecord({ toolName: 'gated', pricing: PRICING })
    }

    function boundRecord(boundTo = PAYER_LOWER): AccessKeyRecord {
        return issueRecord({
            toolName: 'gated',
            pricing: PRICING,
            binding: 'wallet',
            boundTo,
        })
    }

    it('rejects an unbound key when the server requires binding', async () => {
        // The exploit path from issue #1: an unbound key reaching a
        // binding-enabled server used to skip the check entirely and be
        // honored for whoever presented it.
        const record = bearerRecord()
        const store = await seed(record)

        const out = await redeem(store, record.key, 'gated', {
            requireBinding: true,
            clientFingerprint: ATTACKER,
        })
        expect(out).toEqual({ ok: false, reason: 'unbound-key' })
    })

    it('rejects an unbound key even when no fingerprint is presented', async () => {
        const record = bearerRecord()
        const store = await seed(record)

        const out = await redeem(store, record.key, 'gated', { requireBinding: true })
        expect(out).toEqual({ ok: false, reason: 'unbound-key' })
    })

    it('admits the bound wallet', async () => {
        const record = boundRecord()
        const store = await seed(record)

        const out = await redeem(store, record.key, 'gated', {
            requireBinding: true,
            clientFingerprint: PAYER,
        })
        expect(out.ok).toBe(true)
        expect(out.ok && out.record.remainingCalls).toBe(4)
    })

    it('matches addresses case-insensitively', async () => {
        // viem gives the client a checksummed address; a credential may
        // carry a lowercased one. EIP-55 casing is a checksum, not
        // identity, so a case-sensitive compare would lock out the
        // legitimate payer.
        const lowerRecord = boundRecord(PAYER_LOWER)
        const store = await seed(lowerRecord)
        const checksummedClient = await redeem(store, lowerRecord.key, 'gated', {
            requireBinding: true,
            clientFingerprint: PAYER,
        })
        expect(checksummedClient.ok).toBe(true)

        // Mirror image: a record written before normalization landed
        // still carries a checksummed `boundTo`. Seeded directly so it
        // skips issueRecord's normalization.
        const legacy = { ...boundRecord(), boundTo: PAYER }
        const legacyStore = await seed(legacy)
        const loweredClient = await redeem(legacyStore, legacy.key, 'gated', {
            requireBinding: true,
            clientFingerprint: PAYER_LOWER,
        })
        expect(loweredClient.ok).toBe(true)
    })

    it('rejects a different wallet presenting a bound key', async () => {
        const record = boundRecord()
        const store = await seed(record)

        const out = await redeem(store, record.key, 'gated', {
            requireBinding: true,
            clientFingerprint: ATTACKER,
        })
        expect(out).toEqual({ ok: false, reason: 'wrong-client' })
    })

    it('rejects a bound key presented with no fingerprint at all', async () => {
        const record = boundRecord()
        const store = await seed(record)

        const out = await redeem(store, record.key, 'gated')
        expect(out).toEqual({ ok: false, reason: 'wrong-client' })
    })

    it('rejects a record whose boundTo is unparseable rather than treating it as bearer', async () => {
        // Schema drift or a corrupted store value must not degrade to
        // bearer semantics — the record declares an intent to bind.
        const record = { ...bearerRecord(), boundTo: 'garbage' }
        const store = await seed(record)

        const out = await redeem(store, record.key, 'gated')
        expect(out).toEqual({ ok: false, reason: 'wrong-client' })
    })

    it('does not consume a call from the budget on a binding rejection', async () => {
        // Otherwise a stolen key lets an attacker burn the owner's
        // prepaid budget without ever redeeming successfully.
        const record = boundRecord()
        const store = await seed(record)

        for (let i = 0; i < 5; i++) {
            await redeem(store, record.key, 'gated', {
                requireBinding: true,
                clientFingerprint: ATTACKER,
            })
        }

        const stored = await store.get<AccessKeyRecord>(record.key)
        expect(stored?.remainingCalls).toBe(5)

        // The rightful owner still has the full budget.
        const out = await redeem(store, record.key, 'gated', {
            requireBinding: true,
            clientFingerprint: PAYER,
        })
        expect(out.ok && out.record.remainingCalls).toBe(4)
    })

    it('leaves bearer keys working when the server does not require binding', async () => {
        const record = bearerRecord()
        const store = await seed(record)

        const out = await redeem(store, record.key, 'gated')
        expect(out.ok).toBe(true)
    })
})

// -------------------------------------------------------------------
// Layer 3 — the server's pay-and-issue flow
// -------------------------------------------------------------------

describe('server-side fail-closed issuance', () => {
    let handlerRuns = 0
    let logs: ArrayLogEntry[] = []

    const tool: PaidToolDefinition = {
        name: 'gated',
        description: 'Gated tool',
        inputSchema: { msg: z.string().optional() },
        pricing: PRICING,
        handler: async () => {
            handlerRuns++
            return { content: [{ type: 'text', text: 'ok' }] }
        },
    }

    function build(binding: 'none' | 'wallet') {
        handlerRuns = 0
        const { logger, entries } = arrayLogger()
        logs = entries
        return createPaidMcpServer({
            name: 'binding-test',
            version: '0.0.0',
            recipient: RECIPIENT,
            secretKey: SECRET,
            network: 'testnet',
            accessKeyBinding: binding,
            rateLimit: { enabled: false },
            logger,
            tools: [tool],
        })
    }

    it('rejects an unattributable credential before charging, issuing nothing', async () => {
        // A credential is attached (so this is the paid retry, not the
        // 402 probe) but carries no readable payer. Pre-fix this settled
        // the payment and handed back an unbound key.
        const server = build('wallet')
        const extra: Extra = {
            _meta: { [CREDENTIAL_META]: { signature: '0xabc', payload: {} } },
        }

        await expect(
            asInternal(server).runAccessKey(tool, {}, extra, Date.now(), NOOP_SPAN)
        ).rejects.toThrow(ValidationError)

        // Nothing ran, nothing was minted, no payment was taken.
        expect(handlerRuns).toBe(0)
        expect(server.getStats().accessKeysIssued).toBe(0)
        expect(await server.listAccessKeys()).toEqual([])

        // And it's visible to operators rather than failing quietly.
        expect(
            logs.filter(
                (e) =>
                    e.level === 'error' &&
                    e.message === 'wallet-bound access key issuance blocked'
            )
        ).toHaveLength(1)
    })

    it('names the misconfiguration in the error so operators can act', async () => {
        const server = build('wallet')
        const extra: Extra = { _meta: { [CREDENTIAL_META]: { from: 'not-an-address' } } }

        await expect(
            asInternal(server).runAccessKey(tool, {}, extra, Date.now(), NOOP_SPAN)
        ).rejects.toThrow(/accessKeyBinding/)
        await expect(
            asInternal(server).runAccessKey(tool, {}, extra, Date.now(), NOOP_SPAN)
        ).rejects.toThrow(/no payment was taken/)
    })

    it('lets the 402 challenge path through: no credential is not an error', () => {
        // A first call carries no credential at all. That must not be
        // confused with an unreadable one — the client gets a challenge
        // and attaches a credential on retry, which is when we re-check.
        const server = build('wallet')
        const internal = asInternal(server)

        expect(internal.resolveKeyBinding({}, 'gated', 'pre-charge')).toBeUndefined()
        expect(
            internal.resolveKeyBinding({ _meta: {} }, 'gated', 'pre-charge')
        ).toBeUndefined()

        // Once payment has settled, though, an unknown payer is fatal.
        expect(() => internal.resolveKeyBinding({}, 'gated', 'post-charge')).toThrow(
            ValidationError
        )
    })

    it('resolves the payer from either credential shape', () => {
        const internal = asInternal(build('wallet'))

        // mppx puts `from` at the top level for some intents...
        expect(
            internal.resolveKeyBinding(
                { _meta: { [CREDENTIAL_META]: { from: PAYER } } },
                'gated',
                'post-charge'
            )
        ).toBe(PAYER_LOWER)

        // ...and under `payload` for others.
        expect(
            internal.resolveKeyBinding(
                { _meta: { [CREDENTIAL_META]: { payload: { from: PAYER_LOWER } } } },
                'gated',
                'post-charge'
            )
        ).toBe(PAYER_LOWER)
    })

    it('stays out of the way when binding is disabled', () => {
        const internal = asInternal(build('none'))

        // No binding configured: no payer needed, no error, either phase.
        expect(internal.resolveKeyBinding({}, 'gated', 'pre-charge')).toBeUndefined()
        expect(internal.resolveKeyBinding({}, 'gated', 'post-charge')).toBeUndefined()
        expect(
            internal.resolveKeyBinding(
                { _meta: { [CREDENTIAL_META]: { from: PAYER } } },
                'gated',
                'post-charge'
            )
        ).toBeUndefined()
    })
})

// -------------------------------------------------------------------
// The address normalizer both layers depend on
// -------------------------------------------------------------------

describe('normalizeWalletAddress', () => {
    it('lowercases valid addresses', () => {
        expect(normalizeWalletAddress(PAYER)).toBe(PAYER_LOWER)
        expect(normalizeWalletAddress(PAYER_LOWER)).toBe(PAYER_LOWER)
        expect(normalizeWalletAddress(`  ${PAYER}  `)).toBe(PAYER_LOWER)
    })

    it('returns undefined for anything that is not a 20-byte hex address', () => {
        for (const bad of [
            undefined,
            null,
            '',
            '   ',
            'not-an-address',
            PAYER.slice(0, 20), // truncated
            PAYER + '00', // too long
            PAYER.replace('0x', ''), // missing prefix
            PAYER.replace('f', 'z'), // non-hex digit
            42,
            {},
            [PAYER],
        ]) {
            expect(normalizeWalletAddress(bad)).toBeUndefined()
        }
    })
})
