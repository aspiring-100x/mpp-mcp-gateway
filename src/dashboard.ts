/**
 * mpp-mcp-gateway — dashboard
 *
 * Mounts a tiny JSON HTTP API on top of an existing Express app, exposing
 * the server's stats, tool listing, and recent call log. Designed to feed
 * a dashboard UI (the `dashboard/` Vite app ships one) but also useful as
 * a generic monitoring endpoint.
 *
 * The endpoints are read-only and do NOT require authentication out of the
 * box — pin them behind your own middleware in production. Stats can leak
 * revenue and call patterns; protect accordingly.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { createPaidMcpServer, mountDashboard } from 'mpp-mcp-gateway'
 *
 * const server = createPaidMcpServer({ ... })
 * const app = express()
 *
 * // ... mount your MCP transport on /mcp ...
 *
 * mountDashboard(server, app, { prefix: '/api' })
 * app.listen(3010)
 * ```
 */

import type {
    Express,
    Request,
    Response,
    Router,
    NextFunction,
    RequestHandler,
} from 'express'
import type { PaidMcpServer } from './server.js'

export interface DashboardOptions {
    /** URL prefix for the API endpoints. @default '/api' */
    prefix?: string
    /**
     * Optional middleware applied to every dashboard route — handy for
     * wiring auth, rate limiting, or CORS. Receives `(req, res, next)`.
     */
    middleware?: RequestHandler | RequestHandler[]
}

/**
 * Mount the dashboard's JSON API on the given Express app.
 *
 * Adds three GET routes under `prefix`:
 *
 *   GET <prefix>/stats        →  { stats: GatewayStats }
 *   GET <prefix>/tools        →  { tools: [{ name, description, price, ... }] }
 *   GET <prefix>/calls?limit  →  { calls: CallLogEntry[] }   newest first
 *   GET <prefix>/keys         →  { keys: AccessKeyListEntry[] }
 *   DELETE <prefix>/keys/:token →  { revoked: boolean }
 *
 * The `GET` routes are read-only. `DELETE /keys/:token` mutates state
 * (revokes an access key) — protect it with the `middleware` option in
 * production. All routes share the same `middleware`.
 *
 * The function returns the Express app for chaining.
 */
export function mountDashboard(
    server: PaidMcpServer,
    app: Express | Router,
    options: DashboardOptions = {}
): Express | Router {
    const prefix = (options.prefix ?? '/api').replace(/\/$/, '')
    const middleware = normalizeMiddleware(options.middleware)

    const route = (path: string, handler: RequestHandler) => {
        const full = `${prefix}${path}`
        // express's typed overloads for `.get()` don't model variadic
        // middleware cleanly. Cast through unknown so the runtime accepts
        // a flexible (path, ...handlers) call shape.
        const get = app.get.bind(app) as (
            path: string,
            ...handlers: RequestHandler[]
        ) => unknown
        get(full, ...middleware, handler)
    }

    const routeDelete = (path: string, handler: RequestHandler) => {
        const full = `${prefix}${path}`
        const del = app.delete.bind(app) as (
            path: string,
            ...handlers: RequestHandler[]
        ) => unknown
        del(full, ...middleware, handler)
    }

    route('/stats', (_req, res) => {
        res.json({ stats: server.getStats() })
    })

    route('/tools', (_req, res) => {
        // The Zod input schemas in listTools() aren't JSON-serializable, so
        // we project them out for the wire response.
        const tools = server.listTools().map((t) => ({
            name: t.name,
            description: t.description,
            price: t.price,
        }))
        res.json({ tools })
    })

    route('/calls', (req, res) => {
        const requested = parseLimit(req)
        const calls = server.getRecentCalls(requested)
        res.json({ calls })
    })

    // List live access keys issued by this server instance.
    route('/keys', (_req, res) => {
        server
            .listAccessKeys()
            .then((keys) => res.json({ keys }))
            .catch((err: unknown) => {
                res.status(500).json({
                    error: 'internal',
                    message: err instanceof Error ? err.message : String(err),
                })
            })
    })

    // Revoke an access key by token. Mutating — protect with the
    // `middleware` option in production.
    routeDelete('/keys/:token', (req, res) => {
        const raw = (req.params as Record<string, string | string[]>).token
        const token = Array.isArray(raw) ? raw[0] : raw
        if (!token) {
            res.status(400).json({ error: 'invalid-input', message: 'Missing key token' })
            return
        }
        server
            .revokeAccessKey(token)
            .then((result) => {
                if (result.revoked) {
                    res.json(result)
                } else {
                    res.status(404).json({ ...result, error: 'not-found' })
                }
            })
            .catch((err: unknown) => {
                res.status(500).json({
                    error: 'internal',
                    message: err instanceof Error ? err.message : String(err),
                })
            })
    })

    return app
}

/** @internal Coerce `?limit=N` (default 100, max 1000) safely. */
function parseLimit(req: Request): number {
    const raw = req.query.limit
    if (typeof raw !== 'string' || raw.length === 0) return 100
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return 100
    return Math.min(Math.floor(n), 1000)
}

/** @internal Normalize the middleware option to an always-array shape. */
function normalizeMiddleware(
    m: DashboardOptions['middleware']
): RequestHandler[] {
    if (!m) return []
    return Array.isArray(m) ? m : [m]
}

// Re-export types so consumers don't have to dig for them.
export type { Request, Response, NextFunction }
