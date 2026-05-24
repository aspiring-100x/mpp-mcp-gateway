/**
 * mpp-mcp-gateway — store interface
 *
 * The persistence interface used internally for access-key records and
 * (in the future) session-channel state. Three concrete adapters ship
 * with the library:
 *
 *   - `Store.memory()` — single-process; transactional via per-key
 *     promise chains. Default for tests and local dev.
 *   - `Store.upstash(redis)` — multi-instance; uses Lua-script CAS for
 *     atomic operations. Recommended for production deployments.
 *   - `Store.cloudflareKv(namespace)` — edge runtime; best-effort
 *     consistency. Suitable for access keys (tolerates a small
 *     eventual-consistency window) but NOT for session vouchers.
 *
 * Custom backends are encouraged. Implement {@link MppMcpStore} against
 * your storage layer of choice. The interface is small and the contract
 * is documented per method.
 *
 * @see {@link MppMcpStore} for the contract every adapter satisfies
 */

/**
 * Atomic, optionally-persistent key-value store used for access-key
 * records and session-channel state.
 *
 * Implementations must guarantee that {@link MppMcpStore.update}
 * serializes concurrent writers to the same key. If the underlying
 * store is eventually consistent (e.g. Cloudflare KV), the adapter
 * must document that limitation explicitly and the operator must
 * understand which consistency-tolerant uses are safe.
 */
export interface MppMcpStore {
    /**
     * Read the value stored under `key`. Returns `null` if the key is
     * not present (deleted, expired, or never written). The generic
     * parameter is a convenience for type-narrowing at the call site;
     * the store does not validate the shape.
     */
    get<T = unknown>(key: string): Promise<T | null>

    /**
     * Unconditionally set `key` to `value`. Overwrites any existing
     * value. Use {@link MppMcpStore.update} when you need atomicity
     * against concurrent writers.
     */
    put(key: string, value: unknown): Promise<void>

    /**
     * Remove `key` from the store. Idempotent — no error if the key
     * does not exist.
     */
    delete(key: string): Promise<void>

    /**
     * Atomic read-modify-write. The `transform` callback receives the
     * current value (or `null` if missing) and must return either:
     *
     *   - a non-null value to persist as the new state,
     *   - `null` to delete the key (or leave it absent if it was
     *     already missing).
     *
     * The implementation guarantees that no other writer's update is
     * interleaved between the read of `current` and the persistence of
     * the returned value.
     *
     * Important: `transform` MUST be a pure function of its input. Some
     * implementations (e.g. CAS-based backends) call `transform` more
     * than once under contention, retrying with the freshly-observed
     * value until the write succeeds. Side effects in `transform` will
     * be observed multiple times in those cases. If you need to derive
     * an outcome from the operation, compute it from `current` inside
     * `transform` and capture it in a variable visible to your caller —
     * the final invocation's capture corresponds to the value that
     * actually got persisted.
     *
     * Returns the final stored value, or `null` if the operation
     * resulted in a deletion (or a no-op on a missing key).
     */
    update<T = unknown>(
        key: string,
        transform: (current: T | null) => T | null
    ): Promise<T | null>
}

/**
 * A subset of {@link MppMcpStore} matching mppx's legacy three-method
 * `Store.Store` interface. The library accepts these via configuration
 * for backward compatibility and bridges them through {@link bridgeMppxStore}
 * to add a best-effort `update` shim.
 */
export interface LegacyThreeMethodStore {
    get<T = unknown>(key: string): Promise<T | null>
    put(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
}

/**
 * Error thrown by store adapters when persistence fails for reasons
 * outside the caller's control: network timeouts, CAS retry exhaustion,
 * malformed responses from the backend.
 *
 * Re-exported from {@link "../errors"} for the unified error taxonomy.
 * Use `instanceof StoreError` to filter; inspect `.kind` for the
 * specific failure mode.
 */
export { StoreError } from '../errors.js'

/**
 * Type guard for {@link MppMcpStore} — checks whether a candidate
 * supplies the four-method interface (specifically, whether it has an
 * `update` method). Used by {@link bridgeMppxStore} to decide whether a
 * caller-supplied store needs the legacy shim.
 */
export function isMppMcpStore(value: unknown): value is MppMcpStore {
    if (typeof value !== 'object' || value === null) return false
    const v = value as Record<string, unknown>
    return (
        typeof v.get === 'function' &&
        typeof v.put === 'function' &&
        typeof v.delete === 'function' &&
        typeof v.update === 'function'
    )
}
