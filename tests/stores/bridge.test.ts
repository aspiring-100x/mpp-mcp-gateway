/**
 * Tests for the legacy three-method store bridge.
 *
 * The bridge wraps an old `get`/`put`/`delete` store and adds a
 * non-atomic `update` shim. We:
 *
 *   - Verify it satisfies the API contract (compliance tests).
 *   - Skip the strict-atomicity tests because the bridge intentionally
 *     does NOT serialize concurrent writers — that's the whole point
 *     of the warning it emits.
 *   - Verify the construction-time warning fires once per legacy store
 *     instance.
 *   - Verify a four-method store passes through unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    bridgeMppxStore,
    createMemoryStore,
    isMppMcpStore,
    type LegacyThreeMethodStore,
} from '../../src/stores/index.js'
import { runStoreCompliance } from './compliance.js'

/** A naive three-method store for testing the bridge. */
function createLegacyStore(): LegacyThreeMethodStore {
    const data = new Map<string, unknown>()
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
    }
}

runStoreCompliance({
    name: 'bridged-legacy',
    // The bridge logs a warning per new instance; silence it during
    // compliance to keep test output clean.
    build: () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { })
        const store = bridgeMppxStore(createLegacyStore())
        warnSpy.mockRestore()
        return store
    },
    // Best-effort: the bridge does NOT promise atomic in-process update.
    atomicWithinProcess: false,
})

describe('bridge — specifics', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { })
    })

    afterEach(() => {
        warnSpy.mockRestore()
    })

    it('returns the same instance unchanged for a four-method store', () => {
        const native = createMemoryStore()
        const result = bridgeMppxStore(native)
        expect(result).toBe(native)
        // Native stores get no warning.
        expect(warnSpy).not.toHaveBeenCalled()
    })

    it('logs exactly one warning per legacy store instance', () => {
        const legacy = createLegacyStore()
        bridgeMppxStore(legacy)
        bridgeMppxStore(legacy)
        bridgeMppxStore(legacy)
        // Identity-keyed: same instance only fires once.
        expect(warnSpy).toHaveBeenCalledTimes(1)
        expect(warnSpy.mock.calls[0]?.[0]).toMatch(/legacy three-method store/i)
    })

    it('logs separately for distinct legacy instances', () => {
        bridgeMppxStore(createLegacyStore())
        bridgeMppxStore(createLegacyStore())
        expect(warnSpy).toHaveBeenCalledTimes(2)
    })

    it('isMppMcpStore narrows correctly', () => {
        expect(isMppMcpStore(createLegacyStore())).toBe(false)
        expect(isMppMcpStore(createMemoryStore())).toBe(true)
        expect(isMppMcpStore(null)).toBe(false)
        expect(isMppMcpStore({})).toBe(false)
    })
})
