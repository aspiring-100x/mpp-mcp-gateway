/**
 * mpp-mcp-gateway — in-memory store
 *
 * Single-process implementation of {@link MppMcpStore}. Holds state in
 * a `Map`; serializes concurrent `update` calls per-key via a promise
 * chain so atomic read-modify-write is honored without locks or threads.
 *
 * Use cases:
 *   - Tests (the entire test suite runs against this).
 *   - Local development.
 *   - Single-instance production deployments where state durability is
 *     not required (process restart wipes everything).
 *
 * For multi-instance deployments use {@link createUpstashStore} or
 * {@link createCloudflareKvStore} instead.
 */

import type { MppMcpStore } from './types.js'

/**
 * Build an in-memory store. Optionally seed it with initial entries —
 * useful in tests for asserting against pre-populated state.
 *
 * @example
 * ```ts
 * const store = createMemoryStore()
 * await store.put('foo', { count: 1 })
 * const result = await store.update<{ count: number }>('foo', (current) =>
 *   current ? { count: current.count + 1 } : { count: 1 }
 * )
 * // result === { count: 2 }
 * ```
 */
export function createMemoryStore(seed?: Map<string, unknown>): MppMcpStore {
    const data: Map<string, unknown> = seed ? new Map(seed) : new Map()

    /**
     * Per-key serialization. The map's value is the tail of a promise
     * chain — every `update` for that key awaits the previous tail and
     * then registers itself as the new tail. JavaScript's single-threaded
     * model guarantees no other appender can interleave between the read
     * and the assignment.
     *
     * Entries are deleted from `chains` once their tail resolves and no
     * later caller has queued, so the map size stays proportional to
     * keys with active contention rather than every key ever touched.
     */
    const chains = new Map<string, Promise<unknown>>()

    async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = chains.get(key)

        // Build a tail that the next caller can await. We catch and swallow
        // rejection on the tail itself so that one update's failure doesn't
        // poison the chain for subsequent callers — they'll still proceed.
        const work = (previous ? previous.then(() => fn(), () => fn()) : fn())
        chains.set(key, work)

        try {
            return await work
        } finally {
            // If we're still the tail (no later caller queued), clean up.
            // If a caller queued behind us, they overwrote `chains[key]`
            // with their own work — leave their entry in place.
            if (chains.get(key) === work) chains.delete(key)
        }
    }

    return {
        async get<T>(key: string): Promise<T | null> {
            const v = data.get(key)
            return v === undefined ? null : (v as T)
        },

        async put(key: string, value: unknown): Promise<void> {
            data.set(key, value)
        },

        async delete(key: string): Promise<void> {
            data.delete(key)
        },

        async update<T>(
            key: string,
            transform: (current: T | null) => T | null
        ): Promise<T | null> {
            return withLock(key, async () => {
                const current = data.get(key)
                const result = transform(
                    current === undefined ? null : (current as T)
                )
                if (result === null) {
                    data.delete(key)
                    return null
                }
                data.set(key, result)
                return result
            })
        },
    }
}
