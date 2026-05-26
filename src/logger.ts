/**
 * mpp-mcp-gateway — structured logger
 *
 * A small {@link Logger} interface plus three reference implementations:
 *
 *   - {@link consoleLogger} — structured JSON to stderr. Default.
 *     One entry per line, parseable by Datadog/Loki/Cloudwatch.
 *   - {@link silentLogger} — discards everything. For tests and
 *     environments where the gateway should be silent.
 *   - {@link arrayLogger} — captures into an in-memory array. For tests
 *     that want to assert on log output.
 *
 * Plus a redaction wrapper:
 *
 *   - {@link withRedaction} — scrubs sensitive fields from log context
 *     before forwarding. Wraps any other logger.
 *
 * The library accepts a custom logger via `PaidMcpServerConfig.logger`
 * and `PaidMcpClientConfig.logger`. If you don't supply one, we use
 * `withRedaction(consoleLogger())` so secrets are scrubbed and warnings
 * surface by default.
 *
 * Why not use pino/winston directly?
 *
 *   - Adding a logging library as a runtime dependency is heavy for
 *     users who already have one. Our `Logger` interface is small enough
 *     that pino/winston/console adapters are a few lines.
 *   - Some target environments (Cloudflare Workers, Deno Deploy) ban
 *     Node-specific logging libs. A pluggable interface decouples us.
 *   - Production teams have opinions about log format. We let them win
 *     by exposing the seam.
 *
 * Design notes:
 *
 *   - **Stderr, not stdout.** The stdio MCP transport uses stdout for
 *     JSON-RPC traffic. Anything written to stdout pollutes the wire
 *     protocol and breaks clients. Default to stderr for safety.
 *   - **Structured context, not string interpolation.** `info('failed
 *     for tool ' + name)` is unsearchable. `info('tool failed', { tool:
 *     name })` is queryable in any log aggregator. The interface
 *     enforces structure.
 *   - **Errors are first-class.** Pass `MppMcpError` instances under any
 *     context key and the formatter projects them to a clean shape with
 *     `code`, `message`, and recursive `cause`.
 *   - **Child loggers compose.** `serverLogger.child({ tool: 'x' })`
 *     returns a logger whose every entry includes `tool: 'x'` in the
 *     context, regardless of what the call site adds.
 *
 * @module
 */

import { isMppMcpError, type MppMcpError } from './errors.js'
import { writeLogLine } from './runtime.js'

/** Severity level. Filters control which entries actually emit. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** A structured log entry's optional bag of fields. */
export type LogContext = Record<string, unknown>

/**
 * The pluggable logger interface used throughout the library. Any object
 * implementing these four level methods plus `child` works as a logger.
 *
 * Adapters for popular libraries are easy:
 *
 * @example pino adapter
 * ```ts
 * import pino from 'pino'
 * const p = pino({ level: 'info' })
 * const adapter: Logger = {
 *   debug: (m, c) => p.debug(c, m),
 *   info: (m, c) => p.info(c, m),
 *   warn: (m, c) => p.warn(c, m),
 *   error: (m, c) => p.error(c, m),
 *   child: (bindings) => /* same shape over p.child(bindings) *\/,
 * }
 * ```
 */
export interface Logger {
    debug(message: string, context?: LogContext): void
    info(message: string, context?: LogContext): void
    warn(message: string, context?: LogContext): void
    error(message: string, context?: LogContext): void

    /**
     * Return a child logger whose every entry merges `bindings` into
     * the context. Useful for scoping all logs from a tool call or
     * session to include identifying tags.
     *
     * The child must NOT mutate the parent. Bindings on the child do
     * not propagate upward.
     */
    child(bindings: LogContext): Logger
}

// -------------------------------------------------------------------
// Console logger
// -------------------------------------------------------------------

export interface ConsoleLoggerOptions {
    /**
     * Minimum severity to emit. Entries below this level are dropped.
     * @default 'info'
     */
    level?: LogLevel

    /**
     * Whether to pretty-print output instead of structured JSON. Useful
     * for local development; `false` is the right choice for production
     * (log aggregators want JSON).
     * @default false
     */
    pretty?: boolean

    /**
     * Sink to write entries to. Defaults to a runtime-aware writer
     * that targets `process.stderr` on Node and `console.error` on
     * edge runtimes (Workers, Vercel Edge, Deno, Bun). Override in
     * tests or to redirect to a file, network sink, or in-memory
     * buffer.
     */
    write?: (line: string) => void

    /**
     * Bindings to include in every entry from this logger. Used
     * internally by `child()`; you generally don't need to set this
     * yourself.
     */
    bindings?: LogContext
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
}

function defaultWrite(line: string): void {
    // Delegate to the runtime adapter so this default works on Node
    // (writes to fd 2 via process.stderr.write), Cloudflare Workers,
    // Vercel Edge, Deno Deploy, and Bun (writes via console.error).
    // Operators who want a different sink — file, network, in-memory
    // buffer — pass `write` in `ConsoleLoggerOptions`.
    writeLogLine(line)
}

/**
 * Build a console logger. Emits structured JSON to stderr by default.
 * Filters by level. Supports child loggers via merged bindings.
 */
export function consoleLogger(options: ConsoleLoggerOptions = {}): Logger {
    const level = options.level ?? 'info'
    const pretty = options.pretty ?? false
    const write = options.write ?? defaultWrite
    const bindings = options.bindings ?? {}

    const minPriority = LEVEL_PRIORITY[level]

    function emit(entryLevel: LogLevel, message: string, context?: LogContext): void {
        if (LEVEL_PRIORITY[entryLevel] < minPriority) return
        const entry = {
            level: entryLevel,
            time: new Date().toISOString(),
            ...bindings,
            ...(context ? serializeContext(context) : {}),
            message,
        }
        if (pretty) {
            write(formatPretty(entry))
        } else {
            write(safeStringify(entry))
        }
    }

    return {
        debug: (m, c) => emit('debug', m, c),
        info: (m, c) => emit('info', m, c),
        warn: (m, c) => emit('warn', m, c),
        error: (m, c) => emit('error', m, c),
        child: (childBindings) =>
            consoleLogger({
                level,
                pretty,
                write,
                bindings: { ...bindings, ...childBindings },
            }),
    }
}

// -------------------------------------------------------------------
// Silent logger
// -------------------------------------------------------------------

/**
 * A logger that discards every entry. For tests and environments where
 * the gateway should produce no output regardless of level.
 */
export function silentLogger(): Logger {
    const noop = () => {
        /* discard */
    }
    const self: Logger = {
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        child: () => self,
    }
    return self
}

// -------------------------------------------------------------------
// Array logger (test helper)
// -------------------------------------------------------------------

export interface ArrayLogEntry {
    level: LogLevel
    message: string
    context: LogContext
}

/**
 * A logger that captures every entry into an in-memory array. Returns
 * both the logger and the buffer so tests can assert on what was
 * logged. Bindings from `child()` are merged into the captured context.
 *
 * @example
 * ```ts
 * const { logger, entries } = arrayLogger()
 * server.someMethod()  // produces logs
 * expect(entries).toContainEqual({ level: 'warn', message: '...', context: {...} })
 * ```
 */
export function arrayLogger(parentBindings: LogContext = {}): {
    logger: Logger
    entries: ArrayLogEntry[]
} {
    const entries: ArrayLogEntry[] = []

    function build(bindings: LogContext): Logger {
        const push = (level: LogLevel) => (message: string, context?: LogContext) => {
            entries.push({
                level,
                message,
                context: { ...bindings, ...(context ?? {}) },
            })
        }
        return {
            debug: push('debug'),
            info: push('info'),
            warn: push('warn'),
            error: push('error'),
            child: (childBindings) => build({ ...bindings, ...childBindings }),
        }
    }

    return { logger: build(parentBindings), entries }
}

// -------------------------------------------------------------------
// Redaction wrapper
// -------------------------------------------------------------------

export interface RedactionOptions {
    /**
     * Field names to scrub recursively. Matched case-insensitively
     * against object keys at any depth in the context. Defaults cover
     * the sensitive fields the library knows about.
     */
    fields?: string[]

    /**
     * Replacement value for scrubbed fields.
     * @default '[REDACTED]'
     */
    placeholder?: string

    /**
     * Per-key matchers run on every string value. If a value matches
     * one of these regexps, it's replaced with the placeholder.
     * Default: matches long hex blobs (signed tx envelopes) over 200
     * chars to avoid accidentally redacting wallet addresses (40
     * chars) or short identifiers.
     */
    valuePatterns?: RegExp[]
}

const DEFAULT_REDACT_FIELDS = [
    'secretKey',
    'privateKey',
    'feePayerKey',
    'credential',
    'org.paymentauth/credential',
    'signedTransaction',
    'signedTx',
    'authorization',
    'cookie',
    'password',
    'token',
]

const DEFAULT_VALUE_PATTERNS: RegExp[] = [
    // Long hex blobs (>200 chars) — likely signed transactions.
    /^0x[0-9a-fA-F]{200,}$/,
]

/**
 * Wrap a logger with automatic redaction. Sensitive fields are
 * replaced with a placeholder before forwarding. Redaction is recursive
 * — keys matching the watch list at any depth get scrubbed.
 *
 * Use the defaults unless you have specific reasons to deviate:
 *
 * @example use with custom logger
 * ```ts
 * const logger = withRedaction(consoleLogger({ level: 'debug' }))
 * logger.warn('config', { server: { secretKey: 'oops' } })
 * // → ... "server":{"secretKey":"[REDACTED]"} ...
 * ```
 *
 * @example add custom field
 * ```ts
 * const logger = withRedaction(consoleLogger(), {
 *   fields: ['apiKey', 'webhookSecret'],
 * })
 * ```
 */
export function withRedaction(
    inner: Logger,
    options: RedactionOptions = {}
): Logger {
    const fieldSet = new Set(
        (options.fields ?? DEFAULT_REDACT_FIELDS).map((f) => f.toLowerCase())
    )
    const placeholder = options.placeholder ?? '[REDACTED]'
    const valuePatterns = options.valuePatterns ?? DEFAULT_VALUE_PATTERNS

    function redact(value: unknown, ancestors: Set<unknown> = new Set()): unknown {
        if (value === null || value === undefined) return value
        if (typeof value === 'string') {
            for (const re of valuePatterns) {
                if (re.test(value)) return placeholder
            }
            return value
        }
        if (typeof value !== 'object') return value
        // Cycle protection.
        if (ancestors.has(value)) return '[Circular]'
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(value)

        if (Array.isArray(value)) {
            return value.map((item) => redact(item, nextAncestors))
        }
        if (value instanceof Error) {
            // Errors are passed through to serializeContext; redact
            // their `cause` separately if present.
            return value
        }
        const out: Record<string, unknown> = {}
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
            if (fieldSet.has(key.toLowerCase())) {
                out[key] = placeholder
            } else {
                out[key] = redact(v, nextAncestors)
            }
        }
        return out
    }

    function wrap(level: LogLevel) {
        return (message: string, context?: LogContext) => {
            if (!context) {
                inner[level](message)
                return
            }
            inner[level](message, redact(context) as LogContext)
        }
    }

    return {
        debug: wrap('debug'),
        info: wrap('info'),
        warn: wrap('warn'),
        error: wrap('error'),
        child: (bindings) => withRedaction(inner.child(bindings), options),
    }
}

// -------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------

/**
 * Walk the context object and project Error instances (especially
 * `MppMcpError`) into a clean structured shape. Without this,
 * `JSON.stringify` would just emit `{}` for an Error since its
 * properties aren't enumerable.
 */
function serializeContext(context: LogContext): LogContext {
    const out: LogContext = {}
    for (const [key, value] of Object.entries(context)) {
        out[key] = serializeValue(value)
    }
    return out
}

function serializeValue(value: unknown): unknown {
    if (value === null || value === undefined) return value
    if (typeof value !== 'object') return value
    if (value instanceof Error) return serializeError(value)
    if (Array.isArray(value)) return value.map(serializeValue)
    // Plain objects and other classes — serialize properties as-is
    // (the surrounding JSON.stringify handles them).
    return value
}

function serializeError(err: Error): Record<string, unknown> {
    const base: Record<string, unknown> = {
        name: err.name,
        message: err.message,
    }
    if (isMppMcpError(err)) {
        const mpp = err as MppMcpError
        base.code = mpp.code
        if (mpp.cause !== undefined) {
            base.cause =
                mpp.cause instanceof Error
                    ? serializeError(mpp.cause)
                    : mpp.cause
        }
    } else if ('cause' in err && err.cause !== undefined) {
        base.cause =
            err.cause instanceof Error ? serializeError(err.cause) : err.cause
    }
    if (err.stack) base.stack = err.stack
    return base
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        // Cycles or unrepresentable types. Fall back to a minimal
        // entry that won't take down the logger.
        return JSON.stringify({
            level: 'error',
            time: new Date().toISOString(),
            message: 'logger: failed to serialize entry',
        })
    }
}

function formatPretty(entry: Record<string, unknown>): string {
    const { level, time, message, ...rest } = entry
    const prefix = `${String(time)} ${String(level).toUpperCase().padEnd(5)} ${String(message)}`
    if (Object.keys(rest).length === 0) return prefix
    return `${prefix} ${safeStringify(rest)}`
}

// -------------------------------------------------------------------
// Default factory
// -------------------------------------------------------------------

/**
 * Build the library's default logger: `withRedaction(consoleLogger())`.
 * Used when no `logger` is supplied in config.
 */
export function defaultLogger(): Logger {
    return withRedaction(consoleLogger())
}
