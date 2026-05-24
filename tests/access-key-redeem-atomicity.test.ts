/**
 * Tests for the atomicity of access-key redemption.
 *
 * Before v0.2 these tests would fail: the old `redeem` did a `get`
 * then a `put` as separate operations, allowing two concurrent
 * redeemers to both observe `remainingCalls: 1`, both decrement to 0,
 * and both succeed — an over-issuance of one free call.
 *
 * The new `redeem` performs the read-validate-decrement-write inside
 * `store.update`, which the in-memory adapter serializes via per-key
 * promise chains. The result: exactly `remainingCalls` redeems
 * succeed, regardless of how many we fire in parallel.
 *
 * These tests pin that contract.
 */

import { describe, expect, it } from 'vitest'

import {
    issueRecord,
    redeem,
    storeRecord,
    type RedeemResult,
} from '../src/access-keys.js'
import { createMemoryStore } from '../src/stores/index.js'

describe('redeem atomicity', () => {
    it('exactly maxCalls succeed when concurrent redeems exceed the budget', async () => {
        const store = createMemoryStore()
        const record = issueRecord({
            toolName: 't',
            pricing: { type: 'access-key', amount: '1', maxCalls: 50 },
        })
        await storeRecord(store, record)

        // Fire 100 concurrent redeems against a 50-call budget.
        const tasks: Array<Promise<RedeemResult>> = Array.from(
            { length: 100 },
            () => redeem(store, record.key, 't')
        )
        const results = await Promise.all(tasks)

        const successes = results.filter((r) => r.ok).length
        const exhausted = results.filter(
            (r) => !r.ok && r.reason === 'exhausted'
        ).length
        const others = results.filter(
            (r) => !r.ok && r.reason !== 'exhausted'
        ).length

        expect(successes).toBe(50)
        expect(exhausted).toBe(50)
        expect(others).toBe(0)
    })

    it('single-call budgets are respected even at extreme contention', async () => {
        const store = createMemoryStore()
        const record = issueRecord({
            toolName: 't',
            pricing: { type: 'access-key', amount: '1', maxCalls: 1 },
        })
        await storeRecord(store, record)

        const tasks: Array<Promise<RedeemResult>> = Array.from(
            { length: 50 },
            () => redeem(store, record.key, 't')
        )
        const results = await Promise.all(tasks)

        const successes = results.filter((r) => r.ok).length
        const exhausted = results.filter(
            (r) => !r.ok && r.reason === 'exhausted'
        ).length

        // Exactly one redeem is approved; the other 49 see the
        // sticky `exhausted` state.
        expect(successes).toBe(1)
        expect(exhausted).toBe(49)
    })

    it('unlimited-call records do not race-decrement', async () => {
        // Time-bound only key — `remainingCalls: null`. Concurrent
        // redeems should ALL succeed because there's no counter.
        const store = createMemoryStore()
        const record = issueRecord({
            toolName: 't',
            pricing: { type: 'access-key', amount: '1', validFor: '1h' },
        })
        await storeRecord(store, record)

        const tasks: Array<Promise<RedeemResult>> = Array.from(
            { length: 100 },
            () => redeem(store, record.key, 't')
        )
        const results = await Promise.all(tasks)

        const successes = results.filter((r) => r.ok).length
        expect(successes).toBe(100)
    })

    it('reads remainingCalls correctly after partial concurrent drainage', async () => {
        const store = createMemoryStore()
        const record = issueRecord({
            toolName: 't',
            pricing: { type: 'access-key', amount: '1', maxCalls: 30 },
        })
        await storeRecord(store, record)

        // 20 concurrent redeems against a 30-call budget — all succeed.
        await Promise.all(
            Array.from({ length: 20 }, () => redeem(store, record.key, 't'))
        )

        // The next redeem should observe remainingCalls = 10.
        const result = await redeem(store, record.key, 't')
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.record.remainingCalls).toBe(9)
        }
    })

    it('expired records stay sticky (every observer sees expired)', async () => {
        // Sticky terminal state: the record is NOT deleted on expiry.
        // Concurrent redeems all observe the same `expired` reason,
        // avoiding the race where one observer sees `expired` and
        // another (after the delete) sees `unknown`. Backends with TTL
        // evict the record automatically; in-memory accumulates them.
        const store = createMemoryStore()
        const record = issueRecord({
            toolName: 't',
            pricing: { type: 'access-key', amount: '1', validFor: '60s' },
        })
        const expired = {
            ...record,
            expiresAt: new Date(Date.now() - 1000).toISOString(),
        }
        await storeRecord(store, expired)

        const results = await Promise.all(
            Array.from({ length: 10 }, () => redeem(store, expired.key, 't'))
        )
        for (const r of results) {
            expect(r.ok).toBe(false)
            if (!r.ok) expect(r.reason).toBe('expired')
        }
        // Sticky: record remains.
        expect(await store.get(expired.key)).not.toBeNull()
    })
})
