/**
 * Tests for the runtime adapter.
 *
 * Three things to pin:
 *
 *   1. `randomHex` produces hex of the right length and uses
 *      cryptographic randomness (no two calls collide).
 *   2. `writeLogLine` reaches a sink — we monkey-patch the runtime
 *      hooks to verify the dispatch logic without redirecting real
 *      stderr.
 *   3. `isNodeRuntime` reports correctly under the test runner
 *      (which is Node, so it returns true).
 *
 * The goal isn't to simulate every edge runtime — Vitest can't be a
 * Cloudflare Worker — but to verify our abstraction picks the right
 * branch given a synthetic environment and that the contract we
 * advertise (universal hex, best-effort log writes) holds.
 */

import { describe, expect, it, vi } from 'vitest'

import {
    isNodeRuntime,
    randomHex,
    writeLogLine,
} from '../src/runtime.js'

describe('randomHex', () => {
    it('returns a lowercase hex string of length 2 * bytes', () => {
        for (const n of [1, 8, 16, 32, 64]) {
            const out = randomHex(n)
            expect(out).toMatch(/^[0-9a-f]+$/)
            expect(out.length).toBe(n * 2)
        }
    })

    it('produces unique values across many calls', () => {
        // 32 bytes = 256 bits of entropy; the chance of collision in
        // a million-call sample is astronomically small. If this
        // test fails, the underlying RNG is broken.
        const seen = new Set<string>()
        for (let i = 0; i < 10_000; i++) {
            seen.add(randomHex(16))
        }
        expect(seen.size).toBe(10_000)
    })

    it('emits the correct length for byte counts that arent multiples of 4', () => {
        // Catch mistakes in the byte-to-hex loop that could
        // inadvertently truncate or pad.
        expect(randomHex(3).length).toBe(6)
        expect(randomHex(5).length).toBe(10)
        expect(randomHex(17).length).toBe(34)
    })

    it('throws a clear error when Web Crypto is unavailable', () => {
        // `globalThis.crypto` is a getter-only property in modern
        // Node, so we can't reassign it directly. Use
        // Object.defineProperty to swap in a stub for the test then
        // restore the original descriptor afterward.
        const originalDescriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            'crypto'
        )

        try {
            Object.defineProperty(globalThis, 'crypto', {
                value: undefined,
                configurable: true,
                writable: true,
            })
            expect(() => randomHex(16)).toThrow(/Web Crypto is not available/)
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(globalThis, 'crypto', originalDescriptor)
            } else {
                delete (globalThis as { crypto?: unknown }).crypto
            }
        }
    })
})

describe('writeLogLine', () => {
    it('writes to process.stderr.write on Node-like runtimes', () => {
        const calls: string[] = []
        const original = process.stderr.write
            // Monkey-patch stderr.write to capture without polluting test output.
            ; (process.stderr as { write: (s: string) => boolean }).write = (
                line: string
            ) => {
                calls.push(line)
                return true
            }

        try {
            writeLogLine('hello from node')
        } finally {
            ; (process.stderr as { write: (s: string) => boolean }).write =
                original as (s: string) => boolean
        }

        expect(calls).toHaveLength(1)
        expect(calls[0]).toBe('hello from node\n')
    })

    it('falls back to console.error when stderr.write throws', () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { })
        const original = process.stderr.write
            ; (process.stderr as { write: (s: string) => boolean }).write = () => {
                throw new Error('stderr closed')
            }

        try {
            writeLogLine('forced fallback')
            expect(errSpy).toHaveBeenCalledWith('forced fallback')
        } finally {
            ; (process.stderr as { write: (s: string) => boolean }).write =
                original as (s: string) => boolean
            errSpy.mockRestore()
        }
    })

    it('uses console.error when process.stderr is unavailable', () => {
        // Simulate an edge runtime: stash process, clear it, write,
        // then restore. The runtime adapter's runtime probe is a
        // function call (not a cached value) so it sees the change.
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { })
        const original = (globalThis as { process?: unknown }).process
            ; (globalThis as { process?: unknown }).process = undefined

        try {
            writeLogLine('from edge runtime')
            expect(errSpy).toHaveBeenCalledWith('from edge runtime')
        } finally {
            ; (globalThis as { process?: unknown }).process = original
            errSpy.mockRestore()
        }
    })

    it('is silent (does not throw) when no sink is available', () => {
        // Nuke both sinks. The adapter should drop the line rather
        // than crashing — logging is best-effort.
        const originalProcess = (globalThis as { process?: unknown }).process
        const originalConsole = (globalThis as { console?: unknown }).console
            ; (globalThis as { process?: unknown }).process = undefined
            ; (globalThis as { console?: unknown }).console = undefined

        try {
            expect(() => writeLogLine('nowhere to go')).not.toThrow()
        } finally {
            ; (globalThis as { process?: unknown }).process = originalProcess
                ; (globalThis as { console?: unknown }).console = originalConsole
        }
    })
})

describe('isNodeRuntime', () => {
    it('returns true under the test runner (which is Node)', () => {
        expect(isNodeRuntime()).toBe(true)
    })

    it('returns false when process.versions.node is missing', () => {
        const original = (globalThis as { process?: unknown }).process
            ; (globalThis as { process?: unknown }).process = {} // no .versions
        try {
            expect(isNodeRuntime()).toBe(false)
        } finally {
            ; (globalThis as { process?: unknown }).process = original
        }
    })
})
