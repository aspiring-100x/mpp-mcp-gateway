/**
 * mpp-mcp-gateway — error taxonomy
 *
 * A small hierarchy of typed errors so callers can react programmatically
 * without depending on message text. Every error in this module derives
 * from {@link MppMcpError} and carries:
 *
 *   - `code`: a stable string identifier (e.g. `'cap-exceeded'`,
 *     `'cas-exhausted'`, `'invalid-config'`). Use this in `instanceof`
 *     fallbacks or when you can't import the specific subclass.
 *   - `cause`: when an error wraps a lower-level failure (RPC error,
 *     backend exception), the original is preserved so operators can
 *     diagnose without losing the underlying stack.
 *
 * The {@link isMppMcpError} type guard lets you distinguish library
 * errors from arbitrary `Error` values (e.g. errors propagated from
 * user-supplied tool handlers, which are NOT wrapped).
 *
 * Design principles:
 *
 * - Programmatic handling > message parsing. If you find yourself doing
 *   `if (err.message.includes('...'))`, that's a signal we need a more
 *   specific error class or code value. Open an issue.
 * - Errors are values. They carry data via fields, not via prose. The
 *   message is only for humans skimming a log.
 * - We don't wrap user-handler errors. If your `handler` throws, that
 *   error propagates to the agent unchanged (with the appropriate MCP
 *   wire-format wrapper). This module is for errors the gateway itself
 *   raises about its own state.
 *
 * @module
 */

/**
 * Stable error codes used across the library. Each subclass of
 * {@link MppMcpError} sets its `code` to one of these strings.
 *
 * Adding a new code is a minor version bump (a new programmatic
 * branch becomes available); changing or removing one is a major
 * version bump (existing handlers stop firing).
 */
export type MppMcpErrorCode =
    /** Caller-supplied configuration is invalid (caught at construction). */
    | 'invalid-config'
    /** Caller-supplied data is invalid (caught at the API boundary). */
    | 'invalid-input'
    /** A spending cap (per-call or total) would be exceeded if we proceeded. */
    | 'cap-exceeded'
    /** A session-deposit cap would be exceeded if we accepted the channel. */
    | 'session-deposit-cap-exceeded'
    /** A storage operation failed for reasons outside the caller's control. */
    | 'store-backend-error'
    /** A storage value couldn't be parsed (corrupted JSON, schema drift). */
    | 'store-invalid-value'
    /** Optimistic-concurrency retry budget exhausted (Upstash-style backends). */
    | 'cas-exhausted'
    /** Internal invariant violated — file a bug if you see this. */
    | 'internal'

/**
 * Base class for every error this library throws. Use
 * `instanceof MppMcpError` (or {@link isMppMcpError}) to distinguish
 * library errors from user-handler errors.
 *
 * Concrete subclasses fix `code` to a specific {@link MppMcpErrorCode}
 * value and may add typed fields. This class is exported as a type for
 * `instanceof` checks but should not be subclassed by user code — we
 * reserve the right to add concrete subclasses without warning, and
 * downstream subclasses would conflict with our taxonomy.
 */
export abstract class MppMcpError extends Error {
    /**
     * Stable identifier for programmatic handling. See
     * {@link MppMcpErrorCode} for the set of valid values.
     */
    abstract readonly code: MppMcpErrorCode

    /**
     * The originating error this one wraps, when applicable. Inspect
     * `error.cause` for the raw network exception, the Redis error,
     * etc. Note: TypeScript's built-in `Error` already declares
     * `cause` as of ES2022; we override the type to allow `unknown`
     * (rather than `Error | undefined`) since some backends throw
     * non-Error values.
     */
    override readonly cause?: unknown

    constructor(message: string, options?: { cause?: unknown }) {
        super(message)
        // Set a stable, non-class-name `name` so `console.error` and
        // log shippers display something readable regardless of
        // minification.
        this.name = this.constructor.name
        if (options?.cause !== undefined) this.cause = options.cause
    }
}

/**
 * Caller-supplied configuration is invalid. Thrown at construction
 * time so misconfiguration crashes the process immediately rather
 * than silently misbehaving at runtime.
 *
 * Examples:
 *   - `maxPerCall` is zero or negative.
 *   - An access-key tool specifies neither `validFor` nor `maxCalls`.
 *   - `pricing.tiers` is empty in a tiered tool.
 */
export class ConfigurationError extends MppMcpError {
    readonly code = 'invalid-config' as const
}

/**
 * Caller-supplied data is invalid at the API boundary. Distinguished
 * from {@link ConfigurationError}: this fires per-call, not at
 * construction.
 *
 * Examples:
 *   - A USD amount string can't be parsed.
 *   - A duration string ('7d', '15m') is malformed.
 *   - A tool result has more fractional digits than the currency
 *     supports.
 */
export class ValidationError extends MppMcpError {
    readonly code = 'invalid-input' as const
}

/**
 * A storage operation failed for reasons outside the caller's
 * control: network timeout, malformed backend response, CAS retry
 * budget exhausted, JSON parse failure on a stored value.
 *
 * The `kind` field narrows the cause for programmatic handling.
 */
export class StoreError extends MppMcpError {
    readonly code: 'store-backend-error' | 'store-invalid-value' | 'cas-exhausted'

    /**
     * Finer-grained classification of the store failure mode. Mirrors
     * `code` but exposed as its own field for ergonomics:
     * `err.kind === 'cas-exhausted'` reads more naturally than
     * `err.code === 'cas-exhausted'` at use sites.
     */
    readonly kind: 'backend-error' | 'invalid-value' | 'cas-exhausted'

    constructor(args: {
        kind: 'backend-error' | 'invalid-value' | 'cas-exhausted'
        message: string
        cause?: unknown
    }) {
        super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined)
        this.kind = args.kind
        this.code =
            args.kind === 'backend-error'
                ? 'store-backend-error'
                : args.kind === 'invalid-value'
                    ? 'store-invalid-value'
                    : 'cas-exhausted'
    }
}

/**
 * Thrown when a tool call would exceed a configured per-call or total
 * spending cap. The cap check runs BEFORE any transaction is signed,
 * so this error never costs the caller any gas.
 *
 * Pre-existing class; kept here for the unified taxonomy. The shape
 * (with `kind`, `requested`, `limit`, `totalSpent`) is the same as
 * before.
 */
export class SpendingCapExceededError extends MppMcpError {
    readonly code = 'cap-exceeded' as const

    /** Which cap was exceeded — single call or cumulative budget. */
    readonly kind: 'per-call' | 'total'

    /** The amount the server requested, in USD. */
    readonly requested: number

    /** The cap that would be exceeded, in USD. */
    readonly limit: number

    /**
     * Total amount already spent, in USD. Only meaningful when
     * `kind === 'total'`; included so callers can compute "how much
     * more do I have left."
     */
    readonly totalSpent?: number

    constructor(args: {
        kind: 'per-call' | 'total'
        requested: number
        limit: number
        totalSpent?: number
    }) {
        const message =
            args.kind === 'per-call'
                ? `Tool call requires $${args.requested.toFixed(6)} which exceeds maxPerCall cap of $${args.limit.toFixed(2)}.`
                : `Tool call requires $${args.requested.toFixed(6)} which would bring total spend to $${((args.totalSpent ?? 0) + args.requested).toFixed(6)}, exceeding maxTotal cap of $${args.limit.toFixed(2)} (already spent $${(args.totalSpent ?? 0).toFixed(6)}).`
        super(message)
        this.kind = args.kind
        this.requested = args.requested
        this.limit = args.limit
        this.totalSpent = args.totalSpent
    }
}

/**
 * Thrown when a session challenge would deposit more than the
 * configured `maxSessionDeposit` cap. Like
 * {@link SpendingCapExceededError}, this fires before any signing.
 *
 * Pre-existing class; kept here for the unified taxonomy.
 */
export class SessionDepositCapExceededError extends MppMcpError {
    readonly code = 'session-deposit-cap-exceeded' as const

    /** Deposit amount the server suggested, in USD. */
    readonly suggested: number

    /** Configured cap, in USD. */
    readonly limit: number

    constructor(args: { suggested: number; limit: number }) {
        super(
            `Server suggested a session deposit of $${args.suggested.toFixed(6)} but maxSessionDeposit is $${args.limit.toFixed(2)}. ` +
            `Raise maxSessionDeposit or use a server with a smaller suggestedDeposit.`
        )
        this.suggested = args.suggested
        this.limit = args.limit
    }
}

/**
 * Thrown for internal invariant violations — paths that should be
 * unreachable given the type system and earlier validation. If you
 * encounter one of these in production, it's a bug we want to hear
 * about. The error message includes context to help us reproduce.
 */
export class InternalError extends MppMcpError {
    readonly code = 'internal' as const
}

/**
 * Type guard for {@link MppMcpError}. Returns `true` for any error
 * thrown from this library; `false` for everything else (including
 * `Error` instances from user code, third-party libraries, and the
 * MCP SDK).
 */
export function isMppMcpError(err: unknown): err is MppMcpError {
    return err instanceof MppMcpError
}
