/**
 * mpp-mcp-gateway — mppx store adapter
 *
 * mppx >= 0.12 consumes an atomic store whose `update` primitive returns a
 * {@link https://www.npmjs.com/package/mppx | Change} descriptor
 * (`noop` / `set` / `delete`) plus a caller-visible `result`, rather than
 * returning the newly stored value. That contract is strictly more
 * expressive than this library's {@link MppMcpStore}: it can distinguish
 * "leave the value alone" from "write this value" without inspecting the
 * value itself, which is what lets mppx implement replay claims and
 * channel deductions atomically.
 *
 * This module adapts one to the other so that:
 *
 *   - `MppMcpStore` stays the single public store contract for consumers
 *     of this library (no breaking change to `accessKeyStore` /
 *     `sessionStore`), and
 *   - mppx receives a genuine `AtomicStore`, so its replay protection and
 *     session-channel mutations are linearizable on whichever backend the
 *     operator configured — not silently downgraded to a per-process
 *     in-memory default.
 *
 * Wiring the operator's store into mppx is a correctness requirement, not
 * an optimization. Without it mppx falls back to a fresh in-memory store,
 * so consumed transaction hashes and channel state are invisible to other
 * replicas and are lost on restart.
 */

import type { Store as MppxStore } from 'mppx/server'

import type { MppMcpStore } from './types.js'

/**
 * Adapt an {@link MppMcpStore} to the atomic store contract mppx expects.
 *
 * ## Atomicity
 *
 * The adapter is only as atomic as the underlying store. `update` is
 * forwarded directly to {@link MppMcpStore.update}, so the linearizability
 * guarantee is inherited:
 *
 *   - `Store.memory()` — serialized per key within one process.
 *   - `Store.upstash()` — Lua-script CAS, linearizable across instances.
 *   - `Store.cloudflareKv()` — best-effort only; **not** suitable for
 *     mppx replay protection or session channels.
 *
 * ## Transform purity
 *
 * `MppMcpStore.update` may invoke its transform more than once under
 * contention (CAS retry). mppx documents the same requirement for its own
 * callback: it must be synchronous and side-effect free. We therefore
 * capture the `result` of each invocation and return the capture from the
 * final invocation — the one whose write actually landed. This mirrors the
 * captured-outcome pattern already used by access-key redemption.
 *
 * `tryClaim` is deliberately not implemented. mppx falls back to `update`
 * when the adapter does not provide the optimized primitive, and that
 * fallback is atomic whenever `update` is. Supplying a non-atomic
 * `tryClaim` would be strictly worse than the fallback.
 */
export function toMppxAtomicStore(store: MppMcpStore): MppxStore.AtomicStore {
    return {
        get: (key) => store.get(key) as Promise<never>,

        put: (key, value) => store.put(key, value),

        delete: (key) => store.delete(key),

        update: async (key, fn) => {
            // Set on every transform invocation; the final invocation is
            // the one whose returned value was persisted, so its result is
            // the one the caller must observe.
            let captured: unknown
            let captured_set = false

            await store.update(key, (current) => {
                const change = fn(current as never)
                captured = change.result
                captured_set = true

                switch (change.op) {
                    case 'set':
                        return change.value as never
                    case 'delete':
                        // `MppMcpStore.update` treats a `null` return as
                        // "delete the key (or leave it absent)".
                        return null
                    case 'noop':
                        // Returning `current` preserves an existing value
                        // and leaves a missing key missing.
                        return current
                }
            })

            if (!captured_set) {
                // Defensive: a conforming store always invokes the
                // transform at least once. Failing loudly here is better
                // than handing mppx an `undefined` result it would read as
                // a successful claim.
                throw new Error(
                    'Store.update did not invoke its transform; the store does not satisfy the MppMcpStore contract.'
                )
            }

            return captured as never
        },
    }
}
