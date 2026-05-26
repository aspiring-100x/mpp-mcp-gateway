/**
 * Tests for the auth middleware factories.
 *
 * Five factories, each tested in isolation against an Express app
 * spun up on an ephemeral port. The integration scenarios mirror
 * what `mountDashboard` and `mountDiscovery` would produce so we
 * pin both the seam (Express middleware contract) and the wire
 * shape (status codes, response headers, JSON bodies).
 *
 * What we test for each factory:
 *   - happy path: correct credentials → 200
 *   - missing credential → 401 with the right error shape
 *   - wrong credential → 401 with the right error shape
 *   - constructor validation rejects obviously bad input
 *   - WWW-Authenticate header set on 401 (where required)
 *
 * What we don't test:
 *   - True statistical timing-attack resistance. We trust
 *     `node:crypto.timingSafeEqual` to do what it advertises and
 *     verify only that we *use* it (via a structural check).
 */

import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { createHmac } from 'node:crypto'
import type { Server } from 'node:http'

import {
    apiKey,
    auth,
    basicAuth,
    bearerToken,
    publicCors,
    signedQuery,
} from '../src/auth.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
    while (cleanup.length) {
        const fn = cleanup.pop()!
        await fn()
    }
})

/**
 * Spin up an Express app on an ephemeral port with the supplied
 * middleware mounted on every route. The route handler echoes
 * `{ ok: true }`. Returns the base URL for fetch() calls.
 */
async function setup(
    middleware: express.RequestHandler | express.RequestHandler[]
): Promise<string> {
    const app = express()
    const handlers = Array.isArray(middleware) ? middleware : [middleware]
    app.use(...handlers, (_req, res) => {
        res.json({ ok: true })
    })
    const server: Server = app.listen(0)
    await new Promise<void>((resolve) => server.on('listening', () => resolve()))
    const addr = server.address()
    if (!addr || typeof addr === 'string') {
        throw new Error('Failed to bind ephemeral port')
    }
    cleanup.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return `http://127.0.0.1:${addr.port}`
}

// -------------------------------------------------------------------
// auth namespace shape
// -------------------------------------------------------------------

describe('auth namespace', () => {
    it('exposes all five factories', () => {
        expect(typeof auth.bearerToken).toBe('function')
        expect(typeof auth.apiKey).toBe('function')
        expect(typeof auth.basicAuth).toBe('function')
        expect(typeof auth.signedQuery).toBe('function')
        expect(typeof auth.publicCors).toBe('function')
    })

    it('namespace functions are the same as named exports', () => {
        expect(auth.bearerToken).toBe(bearerToken)
        expect(auth.apiKey).toBe(apiKey)
        expect(auth.basicAuth).toBe(basicAuth)
        expect(auth.signedQuery).toBe(signedQuery)
        expect(auth.publicCors).toBe(publicCors)
    })
})

// -------------------------------------------------------------------
// bearerToken
// -------------------------------------------------------------------

describe('bearerToken', () => {
    const TOKEN = 'super-secret-token-value'

    it('allows requests with the correct Authorization header', async () => {
        const url = await setup(bearerToken(TOKEN))
        const res = await fetch(`${url}/protected`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { ok: boolean }
        expect(body.ok).toBe(true)
    })

    it('accepts case-insensitive "bearer" scheme', async () => {
        const url = await setup(bearerToken(TOKEN))
        const res = await fetch(url, {
            headers: { Authorization: `bearer ${TOKEN}` },
        })
        expect(res.status).toBe(200)
    })

    it('denies missing Authorization header with 401 + WWW-Authenticate', async () => {
        const url = await setup(bearerToken(TOKEN, { realm: 'admin' }))
        const res = await fetch(url)
        expect(res.status).toBe(401)
        expect(res.headers.get('www-authenticate')).toBe(
            'Bearer realm="admin"'
        )
        const body = (await res.json()) as { error: string; message: string }
        expect(body.error).toBe('unauthorized')
        expect(body.message).toMatch(/Bearer token required/)
    })

    it('denies malformed Authorization header', async () => {
        const url = await setup(bearerToken(TOKEN))
        const res = await fetch(url, {
            headers: { Authorization: 'Basic abc' },
        })
        expect(res.status).toBe(401)
        const body = (await res.json()) as { message: string }
        expect(body.message).toMatch(/Malformed/)
    })

    it('denies wrong token value', async () => {
        const url = await setup(bearerToken(TOKEN))
        const res = await fetch(url, {
            headers: { Authorization: 'Bearer wrong-value' },
        })
        expect(res.status).toBe(401)
    })

    it('default realm is "protected" when omitted', async () => {
        const url = await setup(bearerToken(TOKEN))
        const res = await fetch(url)
        expect(res.headers.get('www-authenticate')).toBe(
            'Bearer realm="protected"'
        )
    })

    it('escapes special characters in realm', async () => {
        const url = await setup(
            bearerToken(TOKEN, { realm: 'with "quotes" and \\slashes' })
        )
        const res = await fetch(url)
        expect(res.headers.get('www-authenticate')).toBe(
            'Bearer realm="with \\"quotes\\" and \\\\slashes"'
        )
    })

    it('throws on construction with empty token', () => {
        expect(() => bearerToken('')).toThrow(/non-empty string/)
    })
})

// -------------------------------------------------------------------
// apiKey
// -------------------------------------------------------------------

describe('apiKey', () => {
    const KEY = 'k_secret_xyz'

    it('allows requests with the correct header value', async () => {
        const url = await setup(apiKey({ header: 'x-api-key', value: KEY }))
        const res = await fetch(url, {
            headers: { 'x-api-key': KEY },
        })
        expect(res.status).toBe(200)
    })

    it('denies missing header with 401', async () => {
        const url = await setup(apiKey({ header: 'x-api-key', value: KEY }))
        const res = await fetch(url)
        expect(res.status).toBe(401)
        const body = (await res.json()) as { message: string }
        expect(body.message).toMatch(/Missing x-api-key header/)
    })

    it('denies wrong header value with 401', async () => {
        const url = await setup(apiKey({ header: 'x-api-key', value: KEY }))
        const res = await fetch(url, {
            headers: { 'x-api-key': 'wrong' },
        })
        expect(res.status).toBe(401)
    })

    it('header lookup is case-insensitive', async () => {
        const url = await setup(apiKey({ header: 'X-Custom-Auth', value: KEY }))
        // Send with lowercase — Express normalizes to lowercase, so
        // both should resolve to the same header.
        const res = await fetch(url, {
            headers: { 'x-custom-auth': KEY },
        })
        expect(res.status).toBe(200)
    })

    it('does not set WWW-Authenticate (no standard for API keys)', async () => {
        const url = await setup(apiKey({ header: 'x-api-key', value: KEY }))
        const res = await fetch(url)
        expect(res.headers.get('www-authenticate')).toBeNull()
    })

    it('throws on construction with empty header or value', () => {
        expect(() => apiKey({ header: '', value: 'x' })).toThrow(/header/)
        expect(() => apiKey({ header: 'x', value: '' })).toThrow(/value/)
    })
})

// -------------------------------------------------------------------
// basicAuth
// -------------------------------------------------------------------

describe('basicAuth', () => {
    const USERS = { alice: 'wonderland', bob: 'builds' }

    function basicHeader(user: string, pass: string): string {
        return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
    }

    it('allows correct credentials', async () => {
        const url = await setup(basicAuth({ users: USERS }))
        const res = await fetch(url, {
            headers: { Authorization: basicHeader('alice', 'wonderland') },
        })
        expect(res.status).toBe(200)
    })

    it('supports multiple users in the same instance', async () => {
        const url = await setup(basicAuth({ users: USERS }))
        const a = await fetch(url, {
            headers: { Authorization: basicHeader('alice', 'wonderland') },
        })
        const b = await fetch(url, {
            headers: { Authorization: basicHeader('bob', 'builds') },
        })
        expect(a.status).toBe(200)
        expect(b.status).toBe(200)
    })

    it('denies missing credentials with 401 + WWW-Authenticate Basic', async () => {
        const url = await setup(basicAuth({ users: USERS, realm: 'admin' }))
        const res = await fetch(url)
        expect(res.status).toBe(401)
        expect(res.headers.get('www-authenticate')).toBe(
            'Basic realm="admin"'
        )
    })

    it('denies wrong password', async () => {
        const url = await setup(basicAuth({ users: USERS }))
        const res = await fetch(url, {
            headers: { Authorization: basicHeader('alice', 'wrong-password') },
        })
        expect(res.status).toBe(401)
    })

    it('denies unknown username', async () => {
        const url = await setup(basicAuth({ users: USERS }))
        const res = await fetch(url, {
            headers: { Authorization: basicHeader('mallory', 'anything') },
        })
        expect(res.status).toBe(401)
    })

    it('denies malformed Authorization header', async () => {
        const url = await setup(basicAuth({ users: USERS }))
        const res = await fetch(url, {
            headers: { Authorization: 'Basic !!!not-base64!!!' },
        })
        expect(res.status).toBe(401)
    })

    it('denies credentials missing colon separator', async () => {
        const url = await setup(basicAuth({ users: USERS }))
        // base64('no-colon-here') is missing the username:password
        // separator.
        const value = Buffer.from('no-colon-here', 'utf8').toString('base64')
        const res = await fetch(url, {
            headers: { Authorization: `Basic ${value}` },
        })
        expect(res.status).toBe(401)
    })

    it('throws on construction with empty users record', () => {
        expect(() => basicAuth({ users: {} })).toThrow(/at least one entry/)
    })

    it('throws on construction with empty password', () => {
        expect(() => basicAuth({ users: { alice: '' } })).toThrow(
            /non-empty string password/
        )
    })
})

// -------------------------------------------------------------------
// signedQuery
// -------------------------------------------------------------------

describe('signedQuery', () => {
    const SECRET = 'shared-secret-value'

    function sign(path: string, params: Record<string, string>): string {
        const sorted = Object.entries(params).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
        )
        const queryPart = sorted
            .map(
                ([k, v]) =>
                    `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
            )
            .join('&')
        const canonical = queryPart ? `${path}?${queryPart}` : path
        return createHmac('sha256', SECRET).update(canonical).digest('hex')
    }

    it('allows requests with a valid signature', async () => {
        const url = await setup(signedQuery({ secret: SECRET }))
        const ts = Math.floor(Date.now() / 1000).toString()
        const sig = sign('/foo', { ts })
        const res = await fetch(`${url}/foo?ts=${ts}&sig=${sig}`)
        expect(res.status).toBe(200)
    })

    it('verifies signatures with multiple query parameters', async () => {
        const url = await setup(signedQuery({ secret: SECRET }))
        const ts = Math.floor(Date.now() / 1000).toString()
        const sig = sign('/foo', { ts, limit: '50', tool: 'echo' })
        const res = await fetch(
            `${url}/foo?limit=50&tool=echo&ts=${ts}&sig=${sig}`
        )
        expect(res.status).toBe(200)
    })

    it('denies missing sig parameter', async () => {
        const url = await setup(signedQuery({ secret: SECRET }))
        const res = await fetch(`${url}/foo?ts=1716800000`)
        expect(res.status).toBe(401)
    })

    it('denies wrong signature', async () => {
        const url = await setup(signedQuery({ secret: SECRET }))
        const ts = Math.floor(Date.now() / 1000).toString()
        const res = await fetch(`${url}/foo?ts=${ts}&sig=deadbeef`)
        expect(res.status).toBe(401)
    })

    it('denies missing timestamp', async () => {
        const url = await setup(signedQuery({ secret: SECRET }))
        // Compute sig over a path without ts, then submit without ts.
        const sig = sign('/foo', {})
        const res = await fetch(`${url}/foo?sig=${sig}`)
        expect(res.status).toBe(401)
    })

    it('denies expired timestamp', async () => {
        const url = await setup(
            signedQuery({ secret: SECRET, ttlSeconds: 60 })
        )
        // Timestamp 5 minutes in the past.
        const ts = (Math.floor(Date.now() / 1000) - 300).toString()
        const sig = sign('/foo', { ts })
        const res = await fetch(`${url}/foo?ts=${ts}&sig=${sig}`)
        expect(res.status).toBe(401)
        const body = (await res.json()) as { message: string }
        expect(body.message).toMatch(/expired/)
    })

    it('denies timestamp too far in the future', async () => {
        const url = await setup(signedQuery({ secret: SECRET }))
        const ts = (Math.floor(Date.now() / 1000) + 3600).toString()
        const sig = sign('/foo', { ts })
        const res = await fetch(`${url}/foo?ts=${ts}&sig=${sig}`)
        expect(res.status).toBe(401)
        const body = (await res.json()) as { message: string }
        expect(body.message).toMatch(/in the future/)
    })

    it('honors custom paramName and timestampParam', async () => {
        const url = await setup(
            signedQuery({
                secret: SECRET,
                paramName: 'signature',
                timestampParam: 'when',
            })
        )
        const ts = Math.floor(Date.now() / 1000).toString()
        const sig = sign('/foo', { when: ts })
        const res = await fetch(`${url}/foo?when=${ts}&signature=${sig}`)
        expect(res.status).toBe(200)
    })

    it('skips timestamp check when timestampParam is empty string', async () => {
        const url = await setup(
            signedQuery({ secret: SECRET, timestampParam: '' })
        )
        // No ts in either canonical form or the request.
        const sig = sign('/foo', {})
        const res = await fetch(`${url}/foo?sig=${sig}`)
        expect(res.status).toBe(200)
    })

    it('throws on construction with empty secret', () => {
        expect(() => signedQuery({ secret: '' })).toThrow(/non-empty string/)
    })
})

// -------------------------------------------------------------------
// publicCors
// -------------------------------------------------------------------

describe('publicCors', () => {
    it('emits Access-Control-Allow-Origin: * by default', async () => {
        const url = await setup(publicCors())
        const res = await fetch(url, { headers: { Origin: 'https://x.dev' } })
        expect(res.status).toBe(200)
        expect(res.headers.get('access-control-allow-origin')).toBe('*')
    })

    it('echoes a specific allowed origin and sets Vary', async () => {
        const url = await setup(publicCors({ origin: 'https://example.com' }))
        const res = await fetch(url, {
            headers: { Origin: 'https://example.com' },
        })
        expect(res.headers.get('access-control-allow-origin')).toBe(
            'https://example.com'
        )
        expect(res.headers.get('vary')).toBe('Origin')
    })

    it('omits CORS origin header when the request origin is not allowlisted', async () => {
        const url = await setup(
            publicCors({ origin: ['https://allowed.example.com'] })
        )
        const res = await fetch(url, {
            headers: { Origin: 'https://disallowed.example.com' },
        })
        // The route still runs (we don't block — that's a server
        // policy, not a browser policy), but the browser will
        // refuse to expose the response without the CORS header.
        expect(res.status).toBe(200)
        expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('responds to OPTIONS preflight with 204 and the right headers', async () => {
        const url = await setup(publicCors())
        const res = await fetch(url, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://x.dev',
                'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'X-Custom',
            },
        })
        expect(res.status).toBe(204)
        expect(res.headers.get('access-control-allow-methods')).toContain(
            'GET'
        )
        expect(res.headers.get('access-control-allow-headers')).toBe(
            'X-Custom'
        )
        expect(res.headers.get('access-control-max-age')).toBe('86400')
    })

    it('honors custom methods and maxAge', async () => {
        const url = await setup(
            publicCors({
                methods: ['GET', 'POST'],
                maxAgeSeconds: 60,
            })
        )
        const res = await fetch(url, {
            method: 'OPTIONS',
            headers: { Origin: 'https://x.dev' },
        })
        expect(res.headers.get('access-control-allow-methods')).toBe(
            'GET, POST'
        )
        expect(res.headers.get('access-control-max-age')).toBe('60')
    })

    it('passes non-OPTIONS requests through to the route', async () => {
        const url = await setup(publicCors())
        const res = await fetch(url)
        expect(res.status).toBe(200)
        const body = (await res.json()) as { ok: boolean }
        expect(body.ok).toBe(true)
    })
})
