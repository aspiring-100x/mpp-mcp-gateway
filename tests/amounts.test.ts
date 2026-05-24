/**
 * Unit tests for the amount-conversion helpers.
 *
 * These functions are the foundation of revenue tracking. Bugs here would
 * silently corrupt every paid call's bookkeeping, so we exercise each
 * branch — valid forms, edge cases, and rejection paths.
 */

import { describe, expect, it } from 'vitest'

import {
    REVENUE_DECIMALS,
    baseUnitsToUsdString,
    usdStringToBaseUnits,
} from '../src/amounts.js'

describe('usdStringToBaseUnits', () => {
    it('converts standard sub-cent amounts', () => {
        expect(usdStringToBaseUnits('0.001')).toBe(1000n)
        expect(usdStringToBaseUnits('0.0001')).toBe(100n)
        expect(usdStringToBaseUnits('0.000001')).toBe(1n)
    })

    it('converts whole-dollar amounts', () => {
        expect(usdStringToBaseUnits('1')).toBe(1_000_000n)
        expect(usdStringToBaseUnits('100')).toBe(100_000_000n)
        expect(usdStringToBaseUnits('1.000000')).toBe(1_000_000n)
    })

    it('handles leading-decimal forms', () => {
        expect(usdStringToBaseUnits('.5')).toBe(500_000n)
        expect(usdStringToBaseUnits('.001')).toBe(1000n)
    })

    it('handles trailing-decimal and trailing-zero forms', () => {
        expect(usdStringToBaseUnits('1.')).toBe(1_000_000n)
        expect(usdStringToBaseUnits('0.10')).toBe(100_000n)
        expect(usdStringToBaseUnits('0.100000')).toBe(100_000n)
    })

    it('honors a custom decimals override', () => {
        // 18-decimal currency (e.g. ETH-style)
        expect(usdStringToBaseUnits('1', 18)).toBe(10n ** 18n)
        expect(usdStringToBaseUnits('0.000000000000000001', 18)).toBe(1n)
    })

    it('returns zero for "0" and "0.000000"', () => {
        expect(usdStringToBaseUnits('0')).toBe(0n)
        expect(usdStringToBaseUnits('0.000000')).toBe(0n)
    })

    it('rejects malformed input', () => {
        expect(() => usdStringToBaseUnits('')).toThrow(/Invalid USD amount/)
        expect(() => usdStringToBaseUnits('abc')).toThrow(/Invalid USD amount/)
        expect(() => usdStringToBaseUnits('1.2.3')).toThrow(/Invalid USD amount/)
        expect(() => usdStringToBaseUnits('1,000')).toThrow(/Invalid USD amount/)
    })

    it('rejects negative values', () => {
        expect(() => usdStringToBaseUnits('-1')).toThrow(/Invalid USD amount/)
        expect(() => usdStringToBaseUnits('-0.001')).toThrow(/Invalid USD amount/)
    })

    it('rejects more fractional digits than the currency supports', () => {
        // 7 fractional digits with default 6 decimals
        expect(() => usdStringToBaseUnits('0.0000001')).toThrow(
            /fractional digits/
        )
        // 7 fractional digits but a currency that supports only 4 fails too
        expect(() => usdStringToBaseUnits('0.00001', 4)).toThrow(
            /fractional digits/
        )
    })
})

describe('baseUnitsToUsdString', () => {
    it('formats sub-cent amounts with full precision', () => {
        expect(baseUnitsToUsdString(1000n)).toBe('0.001000')
        expect(baseUnitsToUsdString(100n)).toBe('0.000100')
        expect(baseUnitsToUsdString(1n)).toBe('0.000001')
    })

    it('formats whole-dollar amounts', () => {
        expect(baseUnitsToUsdString(1_000_000n)).toBe('1.000000')
        expect(baseUnitsToUsdString(100_000_000n)).toBe('100.000000')
    })

    it('returns the bare string "0" for zero', () => {
        // Matches the `GatewayStats.totalRevenue: '0'` initial value.
        expect(baseUnitsToUsdString(0n)).toBe('0')
    })

    it('honors a custom decimals override', () => {
        expect(baseUnitsToUsdString(10n ** 18n, 18)).toBe(
            '1.000000000000000000'
        )
        expect(baseUnitsToUsdString(1n, 18)).toBe('0.000000000000000001')
    })

    it('throws on negative input', () => {
        expect(() => baseUnitsToUsdString(-1n)).toThrow(
            /negative base units/
        )
    })
})

describe('round-trip', () => {
    it('preserves value for canonical decimal strings', () => {
        const amounts = [
            '0.000001',
            '0.001000',
            '0.500000',
            '1.000000',
            '999.999999',
            '1000000.000000',
        ]
        for (const a of amounts) {
            const units = usdStringToBaseUnits(a)
            const back = baseUnitsToUsdString(units)
            expect(back).toBe(a)
        }
    })

    it('REVENUE_DECIMALS is 6 (Tempo TIP-20 default)', () => {
        expect(REVENUE_DECIMALS).toBe(6)
    })
})
