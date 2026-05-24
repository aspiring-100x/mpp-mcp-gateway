/**
 * mpp-mcp-gateway — legacy store bridge
 *
 * Adapts a three-method `get`/`put`/`delete` store (mppx's legacy
 * `Store.Store` shape) into the four-method {@link MppMcpStore}
 * interface that the rest of the library depends on.
 *
 * The bridged `update` is **best-effort, non-atomic**. We can't add
 * real atomicity to a backend that doesn't expose a CAS primitive, so
 * we do the read-transform-write sequence as faithfully as possible
 * and document the limitation. If you care about atomicity (e.g. for
 * access-key counter decrements), use a native four-method adapter
 * such as {@link createMemoryStore}, {@link createUpstashStore}, or
 * write a custom one against your durable backend.
 *
 * The bridge is invoked transparently inside the server constructor
 * when a caller provides a legacy store via `accessKeyStore` or
 * `sessionStore` config. It also runs once per bridged store to log a
 * one-shot warning so operators know they've opted into the weaker
 * consistency tier.
 */

import {
    isMppMcpStore,
    type LegacyThreeMethodStore,
    type MppMcpStore,
} from './types.js'
import { StoreError } from '../errors.js'
import type { Logger } from '../logger.js'

const WARNING_MESSAGE =
    `Legacy three-method store passed to gateway. update() will be ` +
    `best-effort and is NOT atomic under concurrent writers. For ` +
    `production access-key stores use createMemoryStore() (single ` +
    `instance), createUpstashStore() (multi-instance), or a custom ` +
    `MppMcpStore implementation with native CAS support.`

/**
 * Wrap a legacy three-method store. If the input already implements
 * {@link MppMcpStore} (i.e. has its own `update` method), the input is
 * returned unchanged — the bridge is a no-op for native adapters.
 *
 * The first time a legacy store is bridged in a process, a warning is
 * logged identifying the limitation. Subsequent bridges of the same
 * instance are silent.
 *
 * @param store The legacy store to wrap, or a native MppMcpStore (returned as-is).
 * @param logger Optional logger. If supplied the warning fires through
 *   it; otherwise it goes to `console.warn`. The server passes its
 *   configured logger when bridging at construction time.
 */
export function bridgeMppxStore(
    store: LegacyThreeMethodStore | MppMcpStore,
    logger?: Logger
): MppMcpStore {
    if (isMppMcpStore(store)) return store

    if (!warned.has(store)) {
        warned.add(store)
        if (logger) {
            logger.warn(WARNING_MESSAGE, { component: 'stores.bridge' })
        } else {
            // eslint-disable-next-line no-console
            console.warn(`[mpp-mcp-gateway] ${WARNING_MESSAGE}`)
        }
    }

    return {
        get: store.get.bind(store),
        put: store.put.bind(store),
        delete: store.delete.bind(store),
        async update<T>(
            key: string,
            transform: (current: T | null) => T | null
        ): Promise<T | null> {
            // Read-transform-write. No atomicity. Concurrent writers
            // can produce lost updates or under-counts. We catch and
            // re-throw backend errors as StoreError for consistency
            // with the native adapters.
            let current: T | null
            try {
                current = await store.get<T>(key)
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Legacy store get (during update) failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }

            const next = transform(current)

            try {
                if (next === null) {
                    await store.delete(key)
                    return null
                }
                await store.put(key, next)
                return next
            } catch (err) {
                throw new StoreError({
                    kind: 'backend-error',
                    message: `Legacy store write (during update) failed for key "${key}": ${errMessage(err)}`,
                    cause: err,
                })
            }
        },
    }
}

const warned = new WeakSet<object>()

function errMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
