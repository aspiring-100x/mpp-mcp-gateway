/**
 * mpp-mcp-gateway — auth middleware helpers
 *
 * Five middleware factories for protecting the dashboard and
 * discovery endpoints. Each returns an Express `RequestHandler` that
 * plugs into the `middleware` option of {@link mountDashboard} and
 * {@link mountDiscovery}.
 *
 * Why ship these?
 *
 * Operators kept reinventing the same five auth patterns, often
 * with subtle bugs:
 *   - `req.header('authorization') === 'Bearer ' + token` — timing
 *     attack vulnerable string compare.
 *   - Missing `WWW-Authenticate` header on 401 responses, which
 *     breaks Basic Auth browser prompts and OAuth handshakes.
 *   - Forgetting that `Authorization` headers can be lowercase.
 *   - HMAC verification using `===` instead of `timingSafeEqual`.
 *
 * The factories here use {@link node:crypto}'s `timingSafeEqual`,
 * handle header casing correctly, set the right response headers on
 * denial, and stay within the small contract every middleware should
 * obey: call `next()` on success, send a complete error response and
 * return on denial. They don't throw — Express's default error path
 * leaks stack traces in development and we don't want that for auth.
 *
 * Runtime note: these helpers depend on Express (peer dep) and
 * `node:crypto` (Node-only). Edge runtime deployments mount routes
 * via the platform's native router and write auth in the platform's
 * idiom — these helpers don't apply there. The core gateway
 * (`server.ts`, `client.ts`, stores, rate limit) remains
 * runtime-portable; only this module is Node-bound.
 *
 * @example bearer token on the dashboard
 * ```ts
 * import { mountDashboard, auth } from 'mpp-mcp-gateway'
 *
 * mountDashboard(server, app, {
 *     middleware: auth.bearerToken(process.env.DASHBOARD_TOKEN!, {
 *         realm: 'gateway-admin',
 *     }),
 * })
 * ```
 *
 * @example open CORS on discovery (for registry crawlers)
 * ```ts
 * import { mountDiscovery, auth } from 'mpp-mcp-gateway'
 *
 * mountDiscovery(server, app, {
 *     middleware: auth.publicCors(),
 *     baseUrl: 'https://api.example.com',
 * })
 * ```
 *
 * @module
 */

import { timingSafeEqual, createHmac } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'

// -------------------------------------------------------------------
// Bearer token
// -------------------------------------------------------------------

export interface BearerTokenOptions {
    /**
     * Realm advertised in the `WWW-Authenticate` header on a 401
     * response. Set this to a short, non-secret identifier
     * describing the protected resource (e.g. `'gateway-admin'`).
     * Defaults to `'protected'` if omitted.
     */
    realm?: string
}

/**
 * Build middleware that requires `Authorization: Bearer <token>` on
 * every request. The supplied `token` is compared against the
 * incoming credential using `timingSafeEqual` so the response time
 * doesn't leak information about partial matches.
 *
 * Denials respond with 401 and set `WWW-Authenticate: Bearer
 * realm="..."` so well-behaved clients know how to authenticate.
 */
export function bearerToken(
    token: string,
    options: BearerTokenOptions = {}
): RequestHandler {
    if (!token || typeof token !== 'string') {
        throw new Error('auth.bearerToken: token must be a non-empty string')
    }
    const realm = options.realm ?? 'protected'
    const expected = Buffer.from(token, 'utf8')

    return (req: Request, res: Response, next: NextFunction): void => {
        const header = req.header('authorization')
        if (!header) {
            return deny(res, realm, 'Bearer token required')
        }
        const match = /^Bearer\s+(.+)$/i.exec(header)
        if (!match) {
            return deny(res, realm, 'Malformed Authorization header')
        }
        const supplied = Buffer.from(match[1]!, 'utf8')
        if (!safeEqual(supplied, expected)) {
            return deny(res, realm, 'Invalid bearer token')
        }
        next()
    }
}

function deny(res: Response, realm: string, message: string): void {
    res.set('WWW-Authenticate', `Bearer realm="${escapeRealm(realm)}"`)
    res.status(401).json({ error: 'unauthorized', message })
}

// -------------------------------------------------------------------
// API key (custom header)
// -------------------------------------------------------------------

export interface ApiKeyOptions {
    /**
     * The HTTP header carrying the key. Conventionally `'x-api-key'`
     * (lowercase — Express normalizes incoming headers to lowercase).
     */
    header: string

    /**
     * The exact secret value the header must match.
     */
    value: string
}

/**
 * Build middleware that requires a specific API key in a named
 * header (e.g. `X-API-Key: my-secret`). Constant-time comparison
 * via `timingSafeEqual`.
 *
 * Denials respond with 401. Unlike {@link bearerToken}, no
 * `WWW-Authenticate` header is set — API-key auth has no standard
 * advertisement mechanism.
 */
export function apiKey(options: ApiKeyOptions): RequestHandler {
    if (!options.header || typeof options.header !== 'string') {
        throw new Error('auth.apiKey: header must be a non-empty string')
    }
    if (!options.value || typeof options.value !== 'string') {
        throw new Error('auth.apiKey: value must be a non-empty string')
    }
    const headerName = options.header.toLowerCase()
    const expected = Buffer.from(options.value, 'utf8')

    return (req: Request, res: Response, next: NextFunction): void => {
        const supplied = req.header(headerName)
        if (!supplied) {
            res.status(401).json({
                error: 'unauthorized',
                message: `Missing ${options.header} header`,
            })
            return
        }
        const suppliedBuf = Buffer.from(supplied, 'utf8')
        if (!safeEqual(suppliedBuf, expected)) {
            res.status(401).json({
                error: 'unauthorized',
                message: 'Invalid API key',
            })
            return
        }
        next()
    }
}

// -------------------------------------------------------------------
// HTTP Basic Auth
// -------------------------------------------------------------------

export interface BasicAuthOptions {
    /**
     * Map of `username → password`. Multiple users supported. All
     * comparisons use `timingSafeEqual` regardless of which user is
     * targeted.
     */
    users: Record<string, string>

    /**
     * Realm shown in the browser's auth prompt and advertised on
     * 401. Keep it short — users see this verbatim.
     */
    realm?: string
}

/**
 * Build middleware that requires HTTP Basic Auth. Decodes the base64
 * `Authorization: Basic ...` header, looks up the username, and
 * constant-time compares the password.
 *
 * Denials respond with 401 + `WWW-Authenticate: Basic realm="..."`
 * which triggers the browser's native auth prompt.
 *
 * Use Basic Auth only over HTTPS. The library doesn't enforce this —
 * it can't tell whether your reverse proxy terminates TLS — but
 * sending Basic credentials over plain HTTP is roughly equivalent
 * to publishing them.
 */
export function basicAuth(options: BasicAuthOptions): RequestHandler {
    if (!options.users || typeof options.users !== 'object') {
        throw new Error('auth.basicAuth: users must be a record')
    }
    if (Object.keys(options.users).length === 0) {
        throw new Error('auth.basicAuth: users must contain at least one entry')
    }
    const realm = options.realm ?? 'protected'
    // Pre-encode expected passwords so we don't allocate buffers
    // per-request for users who never call.
    const credentials: Map<string, Buffer> = new Map()
    for (const [user, pw] of Object.entries(options.users)) {
        if (!user || typeof pw !== 'string' || pw.length === 0) {
            throw new Error(
                `auth.basicAuth: user "${user}" must map to a non-empty string password`
            )
        }
        credentials.set(user, Buffer.from(pw, 'utf8'))
    }

    return (req: Request, res: Response, next: NextFunction): void => {
        const header = req.header('authorization')
        if (!header) {
            return denyBasic(res, realm, 'Basic auth required')
        }
        const match = /^Basic\s+(.+)$/i.exec(header)
        if (!match) {
            return denyBasic(res, realm, 'Malformed Authorization header')
        }
        let decoded: string
        try {
            decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
        } catch {
            return denyBasic(res, realm, 'Malformed base64 credentials')
        }
        const sep = decoded.indexOf(':')
        if (sep < 0) {
            return denyBasic(res, realm, 'Credentials missing colon separator')
        }
        const username = decoded.slice(0, sep)
        const password = decoded.slice(sep + 1)
        const expected = credentials.get(username)
        if (!expected) {
            // Still run the safeEqual against a dummy buffer so we
            // don't leak which usernames exist via response timing.
            const dummy = Buffer.from('\0'.repeat(password.length || 1), 'utf8')
            const supplied = Buffer.from(password, 'utf8')
            void safeEqual(supplied, dummy)
            return denyBasic(res, realm, 'Invalid credentials')
        }
        const supplied = Buffer.from(password, 'utf8')
        if (!safeEqual(supplied, expected)) {
            return denyBasic(res, realm, 'Invalid credentials')
        }
        next()
    }
}

function denyBasic(res: Response, realm: string, message: string): void {
    res.set('WWW-Authenticate', `Basic realm="${escapeRealm(realm)}"`)
    res.status(401).json({ error: 'unauthorized', message })
}

// -------------------------------------------------------------------
// Signed query parameters
// -------------------------------------------------------------------

export interface SignedQueryOptions {
    /**
     * Shared secret used to compute and verify the HMAC-SHA-256
     * signature. Treat as a credential — anyone with this secret
     * can mint valid links.
     */
    secret: string

    /**
     * Query parameter name carrying the signature.
     * @default 'sig'
     */
    paramName?: string

    /**
     * Query parameter name carrying the issuance timestamp (Unix
     * seconds). The middleware rejects requests where the timestamp
     * is in the future (clock skew tolerance: 60s) or older than
     * `ttlSeconds`. Set to `''` to disable the timestamp check —
     * useful for permanent signed links, but exposes you to replay
     * if the secret is ever compromised.
     * @default 'ts'
     */
    timestampParam?: string

    /**
     * Maximum age of a signed link, in seconds. Older links are
     * rejected. Pass `Infinity` to disable expiry checks.
     * @default 300 (5 minutes)
     */
    ttlSeconds?: number
}

/**
 * Build middleware that verifies an HMAC-SHA-256 signature embedded
 * in the query string. The signature is computed over the request
 * path + query string (excluding the `sig` parameter itself) using
 * the supplied secret.
 *
 * Pattern: server mints a URL like
 * `/api/calls?ts=1716800000&sig=abc...` where `sig = HMAC-SHA-256(secret, path + sortedQuery)`.
 * Anyone holding the URL can call it; anyone without the secret
 * can't mint new ones.
 *
 * Use cases: pre-signed audit links, time-limited admin URLs, dev
 * tools that share state without persistent auth.
 */
export function signedQuery(options: SignedQueryOptions): RequestHandler {
    if (!options.secret || typeof options.secret !== 'string') {
        throw new Error('auth.signedQuery: secret must be a non-empty string')
    }
    const sigParam = options.paramName ?? 'sig'
    const tsParam = options.timestampParam ?? 'ts'
    const ttlSeconds = options.ttlSeconds ?? 300
    const secret = options.secret

    return (req: Request, res: Response, next: NextFunction): void => {
        const supplied = readQueryString(req.query[sigParam])
        if (!supplied) {
            res.status(401).json({
                error: 'unauthorized',
                message: `Missing ${sigParam} query parameter`,
            })
            return
        }

        // Optional timestamp check.
        if (tsParam) {
            const ts = readQueryString(req.query[tsParam])
            if (!ts) {
                res.status(401).json({
                    error: 'unauthorized',
                    message: `Missing ${tsParam} query parameter`,
                })
                return
            }
            const tsNum = Number(ts)
            if (!Number.isFinite(tsNum)) {
                res.status(401).json({
                    error: 'unauthorized',
                    message: `Invalid ${tsParam} query parameter`,
                })
                return
            }
            const nowSec = Math.floor(Date.now() / 1000)
            // 60s skew tolerance for "future" timestamps.
            if (tsNum > nowSec + 60) {
                res.status(401).json({
                    error: 'unauthorized',
                    message: 'Signature timestamp is in the future',
                })
                return
            }
            if (Number.isFinite(ttlSeconds) && nowSec - tsNum > ttlSeconds) {
                res.status(401).json({
                    error: 'unauthorized',
                    message: 'Signature has expired',
                })
                return
            }
        }

        const canonical = canonicalQueryString(req, sigParam)
        const expected = createHmac('sha256', secret)
            .update(canonical)
            .digest('hex')

        const a = Buffer.from(supplied, 'utf8')
        const b = Buffer.from(expected, 'utf8')
        if (!safeEqual(a, b)) {
            res.status(401).json({
                error: 'unauthorized',
                message: 'Invalid signature',
            })
            return
        }
        next()
    }
}

/**
 * @internal Build the canonical string the signature is computed
 * over: `${path}?${sortedQueryWithoutSig}`. Sorting ensures the
 * caller and server agree regardless of how query keys were
 * serialized client-side.
 */
function canonicalQueryString(req: Request, sigParam: string): string {
    const entries: Array<[string, string]> = []
    for (const [key, value] of Object.entries(req.query)) {
        if (key === sigParam) continue
        const stringValue = readQueryString(value)
        if (stringValue === undefined) continue
        entries.push([key, stringValue])
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const queryPart = entries
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    // req.path strips the query string. Use it directly to avoid
    // double-counting query content in the canonical form.
    return queryPart.length > 0 ? `${req.path}?${queryPart}` : req.path
}

function readQueryString(value: unknown): string | undefined {
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    return undefined
}

// -------------------------------------------------------------------
// Public CORS (for registry crawlers)
// -------------------------------------------------------------------

export interface PublicCorsOptions {
    /**
     * Allowed origins. Use `'*'` for any origin (typical for
     * publicly crawled discovery docs). Pass an array of strings
     * for an explicit allowlist.
     * @default '*'
     */
    origin?: string | string[]

    /**
     * Allowed HTTP methods. The discovery and dashboard APIs are
     * read-only, so `['GET']` is the safe default. If you mount
     * something behind `mountDashboard` that takes POST, override
     * this.
     * @default ['GET']
     */
    methods?: string[]

    /**
     * Browser cache window for preflight responses, in seconds. Set
     * to `0` to disable preflight caching.
     * @default 86_400 (24 hours)
     */
    maxAgeSeconds?: number
}

/**
 * Build middleware that emits permissive CORS headers suitable for
 * registry crawlers and public read-only endpoints. Responds to
 * OPTIONS preflights directly; passes other requests through.
 *
 * Defaults are deliberately conservative: GET-only, no credentials,
 * no exposed headers beyond the ones the spec calls for. This is
 * what mpp.land and other crawlers actually need to consume your
 * `/openapi.json`.
 *
 * Don't use this middleware to protect *private* routes — it grants
 * cross-origin access to any caller. For private dashboards, layer
 * `auth.bearerToken` or `auth.basicAuth` on top.
 */
export function publicCors(options: PublicCorsOptions = {}): RequestHandler {
    const origin = options.origin ?? '*'
    const methods = (options.methods ?? ['GET']).join(', ')
    const maxAge = options.maxAgeSeconds ?? 86_400

    return (req: Request, res: Response, next: NextFunction): void => {
        const requestOrigin = req.header('origin')
        const allowed = resolveAllowedOrigin(requestOrigin, origin)

        if (allowed) {
            res.set('Access-Control-Allow-Origin', allowed)
            // Vary tells caches the response depends on the request's
            // Origin header — required when serving multiple origins
            // through the same path.
            if (origin !== '*') res.set('Vary', 'Origin')
        }
        res.set('Access-Control-Allow-Methods', methods)
        res.set('Access-Control-Max-Age', String(maxAge))

        // Handle preflight directly — no need to pass to the route.
        if (req.method === 'OPTIONS') {
            // Echo any requested headers back as allowed (the read-
            // only endpoints don't enforce specific headers).
            const reqHeaders = req.header('access-control-request-headers')
            if (reqHeaders) {
                res.set('Access-Control-Allow-Headers', reqHeaders)
            }
            res.status(204).end()
            return
        }

        next()
    }
}

function resolveAllowedOrigin(
    requestOrigin: string | undefined,
    config: string | string[]
): string | undefined {
    if (config === '*') return '*'
    if (typeof config === 'string') {
        return requestOrigin === config ? config : undefined
    }
    if (Array.isArray(config)) {
        return requestOrigin && config.includes(requestOrigin)
            ? requestOrigin
            : undefined
    }
    return undefined
}

// -------------------------------------------------------------------
// Internal helpers
// -------------------------------------------------------------------

/**
 * @internal Constant-time buffer comparison. Returns false when the
 * lengths differ rather than throwing — `timingSafeEqual` itself
 * requires equal lengths, but the length difference is itself a
 * leak we can avoid by short-circuiting at our boundary.
 *
 * The trick: if lengths differ, run a dummy timingSafeEqual against
 * the supplied buffer + a same-length zero buffer. This consumes
 * roughly the same time as a real comparison would, smoothing the
 * timing signal. Then return false.
 */
function safeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) {
        const dummy = Buffer.alloc(a.length)
        try {
            timingSafeEqual(a, dummy)
        } catch {
            /* swallow: this branch is purely for time smoothing */
        }
        return false
    }
    return timingSafeEqual(a, b)
}

/**
 * @internal Escape characters that would terminate the realm value
 * in a `WWW-Authenticate` header. Keeps RFC 7235 valid: `realm` is
 * a quoted-string and embedded `"` or `\` need backslash-escaping.
 */
function escapeRealm(realm: string): string {
    return realm.replace(/([\\"])/g, '\\$1')
}

// -------------------------------------------------------------------
// Public namespace
// -------------------------------------------------------------------

/**
 * Convenience namespace that mirrors the import shape used in the
 * main JSDoc examples: `auth.bearerToken(...)`,
 * `auth.basicAuth(...)`, etc. The individual factory functions are
 * also exported as named exports for tree-shaking.
 */
export const auth = {
    bearerToken,
    apiKey,
    basicAuth,
    signedQuery,
    publicCors,
} as const
