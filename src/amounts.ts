/**
 * mpp-mcp-gateway — amount math
 *
 * Tiny helpers for converting USD decimal strings to base units (BigInt)
 * and back. Used internally for revenue tracking — keeping all math in
 * `bigint` base units avoids the silent precision loss and accumulated
 * drift you get from `parseFloat`/`toFixed` round-trips on money values.
 *
 * The convention throughout the library: amounts are represented as
 * USD decimal strings at the API boundary (e.g. `'0.001'`), as `bigint`
 * base units internally (e.g. `1000n` with 6 decimals), and as decimal
 * strings again on read (e.g. `'0.001000'`).
 *
 * @example
 * ```ts
 * usdStringToBaseUnits('0.001', 6)       // 1000n
 * baseUnitsToUsdString(1000n, 6)         // '0.001000'
 * baseUnitsToUsdString(0n, 6)            // '0'  (special case)
 * ```
 */

/**
 * Default decimal precision for revenue arithmetic. Matches Tempo's
 * TIP-20 stablecoin convention (pathUSD, alphaUSD, betaUSD, thetaUSD all
 * use 6 decimals). Override via the second argument when working with a
 * currency that has different precision.
 */
export const REVENUE_DECIMALS = 6

/**
 * Convert a non-negative USD decimal string to base units.
 *
 * Accepts forms like `'0.001'`, `'1.5'`, `'.5'`, `'1'`, `'1.'`. Throws on
 * negatives, malformed input, or amounts with more fractional digits than
 * the currency supports.
 *
 * @example
 * ```ts
 * usdStringToBaseUnits('0.001', 6)   // 1000n
 * usdStringToBaseUnits('1', 6)       // 1000000n
 * usdStringToBaseUnits('.5', 6)      // 500000n
 * usdStringToBaseUnits('0.0000001', 6) // throws — 7 fractional digits
 * ```
 */
export function usdStringToBaseUnits(amount: string, decimals = REVENUE_DECIMALS): bigint {
    const trimmed = amount.trim()
    if (!/^(\d+\.?\d*|\.\d+)$/.test(trimmed)) {
        throw new Error(
            `Invalid USD amount: "${amount}". Expected a non-negative decimal string ` +
            `like "0.001", "1", or ".5".`
        )
    }
    // Normalize ".5" → "0.5" so split('.') gives a non-empty whole part.
    const normalized = trimmed.startsWith('.') ? '0' + trimmed : trimmed
    const [whole = '0', fractional = ''] = normalized.split('.')
    if (fractional.length > decimals) {
        throw new Error(
            `Amount "${amount}" has ${fractional.length} fractional digits, ` +
            `but the currency only supports ${decimals}.`
        )
    }
    const padded = fractional.padEnd(decimals, '0')
    return BigInt(whole + padded)
}

/**
 * Convert non-negative base units to a USD decimal string with full
 * fractional precision (e.g. `'0.001000'`, not `'0.001'`).
 *
 * Special case: `0n` returns `'0'` rather than `'0.000000'` to match the
 * convention used elsewhere in the library (`GatewayStats.totalRevenue`
 * starts as `'0'` before any payments).
 *
 * @example
 * ```ts
 * baseUnitsToUsdString(1000n, 6)        // '0.001000'
 * baseUnitsToUsdString(1000000n, 6)     // '1.000000'
 * baseUnitsToUsdString(0n, 6)           // '0'
 * ```
 */
export function baseUnitsToUsdString(units: bigint, decimals = REVENUE_DECIMALS): string {
    if (units === 0n) return '0'
    if (units < 0n) {
        throw new Error(`Cannot format negative base units: ${units}`)
    }
    const divisor = 10n ** BigInt(decimals)
    const whole = units / divisor
    const fractional = units % divisor
    const fractionalStr = fractional.toString().padStart(decimals, '0')
    return `${whole}.${fractionalStr}`
}
