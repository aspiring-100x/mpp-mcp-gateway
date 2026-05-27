/**
 * mpp-mcp-gateway — runtime adapter
 *
 * Tiny abstraction layer over runtime-specific APIs the library
 * uses internally. The public API stays the same regardless of
 * where the gateway runs; this module hides the platform fork.
 *
 * Supported runtimes:
 *
 *   - **Node.js** (LTS — 20+): full support including process.stderr.
 *   - **Cloudflare Workers**: works via Web Crypto + `console.error`.
 *   - **Vercel Edge / Deno Deploy / Bun**: same path as Workers.
 *   - **Browsers**: works for the client-side library; the server
 *     library is meant for service environments only.
 *
 * Two surfaces are abstracted:
 *
 *   1. {@link randomHex} — cryptographically random hex string.
 *      Replaces `node:crypto`'s `randomBytes`. Uses
 *      `globalThis.crypto.getRandomValues` which is universal in
 *      Node 19+ and every modern web/edge runtime.
 *
 *   2. {@link writeLogLine} — append a line to the runtime's standard
 *      error stream. Picks `process.stderr.write` when available
 *      (preferred — never collides with stdout MCP transport),
 *      falls back to `console.error` otherwise.
 *
 * @module
 */

/**
 * Generate `bytes` cryptographically random bytes and return them as
 * a lowercase hex string of length `bytes * 2`.
 *
 * Uses Web Crypto, which is available as `globalThis.crypto` in:
 *   - Node.js 19+
 *   - Cloudflare Workers (always)
 *   - Vercel Edge (always)
 *   - Deno (always)
 *   - Browsers (always, in secure contexts)
 *   - Bun (always)
 *
 * Throws if Web Crypto is unavailable, which on supported runtimes
 * should never happen. The error message names the runtime so
 * operators on truly esoteric platforms can plug in a polyfill.
 *
 * @example
 * ```ts
 * randomHex(32)  // 64-char hex, e.g. '5f3a7c2b9e1d4a6f8b3c5e7a9f1b3d5e...'
 * ```
 */
export function randomHex(bytes: number): string {
    const c = (globalThis as { crypto?: Crypto }).crypto
    if (!c || typeof c.getRandomValues !== 'function') {
        throw new Error(
            `Web Crypto is not available in this runtime. ` +
            `mpp-mcp-gateway requires Node 19+, Cloudflare Workers, ` +
            `Vercel Edge, Deno, Bun, or a similar environment exposing ` +
            `globalThis.crypto.getRandomValues.`
        )
    }
    const buf = new Uint8Array(bytes)
    c.getRandomValues(buf)
    // Convert to hex without depending on Buffer (Node-only).
    let out = ''
    for (let i = 0; i < buf.length; i++) {
        out += buf[i]!.toString(16).padStart(2, '0')
    }
    return out
}

/**
 * Append `line` (without trailing newline) to the standard error
 * stream of the current runtime. Picks the most efficient sink
 * available:
 *
 *   - `process.stderr.write` on Node — bypasses console formatting
 *     and goes straight to fd 2.
 *   - `console.error` everywhere else (Workers, Edge, Deno, Bun) —
 *     same destination semantically.
 *
 * Safe to call from any runtime. If neither sink is available
 * (extremely unusual, e.g. embedded JS engines), the call is a
 * silent no-op rather than throwing — logging is best-effort and
 * shouldn't take down the gateway.
 */
export function writeLogLine(line: string): void {
    // Node.js fast path: write directly to the process stderr stream.
    // Avoids console.error's formatting overhead and guarantees the
    // line lands on fd 2 unambiguously.
    const proc = (globalThis as { process?: { stderr?: { write?: (s: string) => unknown } } })
        .process
    if (proc?.stderr?.write) {
        try {
            proc.stderr.write(line + '\n')
            return
        } catch {
            // Fall through to console.error if stderr.write throws
            // (e.g. closed file descriptor during shutdown).
        }
    }

    // Edge / Worker / browser path: console.error appends a newline
    // automatically and routes to the runtime's diagnostic stream.
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
        try {
            console.error(line)
            return
        } catch {
            /* silent fallback */
        }
    }

    // Last resort: drop the line. Better than crashing the process.
}

/**
 * Compute an HMAC-SHA-256 of `body` using `secret` and return the
 * hex-encoded digest. Async because Web Crypto's HMAC API is async
 * by design (it works the same on Node 19+, Cloudflare Workers,
 * Vercel Edge, Deno, and Bun).
 *
 * Note: Node's native `node:crypto.createHmac` is faster and
 * synchronous, but importing it would block this helper on Node-
 * only runtimes. We keep the universal path; the cost difference
 * is negligible for webhook dispatch (microseconds per call).
 *
 * @example
 * ```ts
 * const sig = await hmacSha256Hex('shared-secret', 'message-body')
 * // → 64-char lowercase hex
 * ```
 */
export async function hmacSha256Hex(
    secret: string,
    body: string
): Promise<string> {
    const c = (globalThis as { crypto?: Crypto }).crypto
    if (!c?.subtle) {
        throw new Error(
            `Web Crypto subtle API is not available in this runtime. ` +
            `mpp-mcp-gateway requires Node 19+, Cloudflare Workers, ` +
            `Vercel Edge, Deno, Bun, or a similar environment.`
        )
    }
    const enc = new TextEncoder()
    const key = await c.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    )
    const sig = await c.subtle.sign('HMAC', key, enc.encode(body))
    const buf = new Uint8Array(sig)
    let out = ''
    for (let i = 0; i < buf.length; i++) {
        out += buf[i]!.toString(16).padStart(2, '0')
    }
    return out
}

/**
 * Detect whether the current runtime is Node.js. Useful for code
 * paths that want to pick a runtime-specific behavior without
 * routing through the abstractions above.
 */
export function isNodeRuntime(): boolean {
    const proc = (globalThis as { process?: { versions?: { node?: string } } }).process
    return typeof proc?.versions?.node === 'string'
}
