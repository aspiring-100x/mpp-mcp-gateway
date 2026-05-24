/**
 * mpp-mcp-gateway — store adapters
 *
 * Persistent state for access-key records (and, post-v0.2, session
 * channels). Three native adapters ship with the library:
 *
 *   - {@link createMemoryStore} — in-process. Atomic via promise-chain
 *     serialization. Default for tests and single-instance deployments.
 *
 *   - {@link createUpstashStore} — Upstash Redis over HTTP. Atomic via
 *     Lua-script CAS. Recommended for production deployments on Vercel,
 *     Lambda, Fly, or anywhere with HTTP egress to Upstash.
 *
 *   - {@link createCloudflareKvStore} — Cloudflare Workers KV.
 *     Best-effort consistency (NOT atomic across regions). Suitable
 *     for access-key stores with low contention; unsafe for session
 *     vouchers. See the module-level docstring on `cloudflare-kv.ts`.
 *
 * Custom backends are first-class: implement {@link MppMcpStore} and
 * pass the result via `accessKeyStore` or `sessionStore` config. The
 * library will use it directly without wrapping.
 *
 * Legacy three-method stores (mppx's older `Store.Store` shape) are
 * accepted via {@link bridgeMppxStore}, which adds a non-atomic
 * best-effort `update` shim and logs a warning. New code should use
 * one of the native adapters above.
 *
 * Re-exported under a single `Store` namespace for ergonomic imports:
 *
 * @example
 * ```ts
 * import { Store } from 'mpp-mcp-gateway/stores'
 *
 * const accessKeyStore = Store.memory()
 * // or:
 * const accessKeyStore = Store.upstash(redis, { keyPrefix: 'mppmcp:' })
 * // or:
 * const accessKeyStore = Store.cloudflareKv(env.MPPMCP_KV)
 * ```
 */

import { createMemoryStore } from './memory.js'
import { createUpstashStore } from './upstash.js'
import { createCloudflareKvStore } from './cloudflare-kv.js'
import { bridgeMppxStore } from './bridge.js'

export {
    createMemoryStore,
    createUpstashStore,
    createCloudflareKvStore,
    bridgeMppxStore,
}

export {
    type MppMcpStore,
    type LegacyThreeMethodStore,
    StoreError,
    isMppMcpStore,
} from './types.js'
export type { UpstashRedisLike, UpstashStoreOptions } from './upstash.js'
export type {
    CloudflareKvLike,
    CloudflareKvStoreOptions,
} from './cloudflare-kv.js'
export { CLOUDFLARE_KV_SESSION_WARNING } from './cloudflare-kv.js'

/**
 * Convenience namespace mirroring the import shape:
 * `Store.memory()`, `Store.upstash(redis)`, `Store.cloudflareKv(ns)`,
 * `Store.bridge(legacy)`.
 */
export const Store = {
    memory: createMemoryStore,
    upstash: createUpstashStore,
    cloudflareKv: createCloudflareKvStore,
    bridge: bridgeMppxStore,
} as const
