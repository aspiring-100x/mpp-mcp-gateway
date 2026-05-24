/**
 * Tests for the in-memory store adapter.
 *
 * Runs the shared compliance suite plus memory-specific tests for the
 * promise-chain locking implementation.
 */

import { describe, expect, it } from 'vitest'

import { createMemoryStore } from '../../src/stores/index.js'
import { runStoreCompliance } from './compliance.js'

runStoreCompliance({
    name: 'memory',
    build: () => createMemoryStore(),
    atomicWithinProcess: true,
})

describe('memory store — specifics', () => {
    it('seeds initial entries when given a Map', async () => {
        const seed = new Map<string, unknown>([
            ['a', { v: 1 }],
            ['b', { v: 2 }],
        ])
        const s = createMemoryStore(seed)
        expect(await s.get('a')).toEqual({ v: 1 })
        expect(await s.get('b')).toEqual({ v: 2 })
    })

    it('seed map is copied — external mutations after construction are ignored', async () => {
        const seed = new Map<string, unknown>([['a', { v: 1 }]])
        const s = createMemoryStore(seed)
        seed.set('a', { v: 999 })
        // The store snapshot remains the original.
        expect(await s.get('a')).toEqual({ v: 1 })
    })

    it('serializes updates against a single key but parallelizes across keys', async () => {
        const s = createMemoryStore()
        await s.put('a', { n: 0 })
        await s.put('b', { n: 0 })

        // Issue 50 increments to 'a' and 50 to 'b' interleaved.
        const ops: Array<Promise<unknown>> = []
        for (let i = 0; i < 50; i++) {
            ops.push(
                s.update<{ n: number }>('a', (cur) => ({
                    n: (cur?.n ?? 0) + 1,
                }))
            )
            ops.push(
                s.update<{ n: number }>('b', (cur) => ({
                    n: (cur?.n ?? 0) + 1,
                }))
            )
        }
        await Promise.all(ops)

        expect(await s.get<{ n: number }>('a')).toEqual({ n: 50 })
        expect(await s.get<{ n: number }>('b')).toEqual({ n: 50 })
    })

    it('a thrown error in update propagates and does not poison the chain', async () => {
        const s = createMemoryStore()
        await s.put('k', { count: 1 })

        // First update throws.
        await expect(
            s.update('k', () => {
                throw new Error('simulated transform error')
            })
        ).rejects.toThrow(/simulated transform error/)

        // Second update should still work and see the original value.
        const result = await s.update<{ count: number }>('k', (cur) => ({
            count: (cur?.count ?? 0) + 1,
        }))
        expect(result).toEqual({ count: 2 })
    })
})
