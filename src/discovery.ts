/**
 * mpp-mcp-gateway — discovery
 *
 * Generates and serves an OpenAPI 3.1 document describing the server's
 * tools, with `x-payment-info` extensions per the MPP service-discovery
 * IETF draft (`draft-payment-discovery-00`). Public registries like
 * mpp.land and mpp.directory crawl this document automatically — no
 * manual submission required.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { createPaidMcpServer, mountDiscovery } from 'mpp-mcp-gateway'
 *
 * const server = createPaidMcpServer({ ... })
 * const app = express()
 * mountDiscovery(server, app, {
 *     baseUrl: 'https://api.example.com',
 *     categories: ['data', 'search'],
 *     docs: { homepage: 'https://example.com/docs' },
 * })
 * app.listen(3010)
 * // GET /openapi.json now serves a discoverable spec.
 * ```
 *
 * @see https://github.com/tempoxyz/mpp-specs/blob/main/specs/extensions/draft-payment-discovery-00.md
 */

import type { Express, Router, RequestHandler } from 'express'
import { z } from 'zod'

import { ValidationError } from './errors.js'
import type { PaidMcpServer } from './server.js'
import type { PricingModel } from './types.js'

/** Service category strings recommended by the MPP discovery spec. */
export type ServiceCategory =
    | 'communication'
    | 'compute'
    | 'data'
    | 'developer-tools'
    | 'media'
    | 'search'
    | 'social'
    | 'storage'
    | 'travel'
    // free-form values are also allowed per the spec
    | (string & {})

export interface DiscoveryOptions {
    /** URL path where the OpenAPI document is served. @default '/openapi.json' */
    path?: string
    /**
     * Public base URL of the deployed server (e.g. `'https://api.example.com'`).
     * Embedded in `servers[0].url` of the OpenAPI document. Without it,
     * registries can still crawl by host but `servers[]` will be omitted.
     */
    baseUrl?: string
    /** Service categories per `x-service-info.categories`. */
    categories?: ServiceCategory[]
    /** Documentation links per `x-service-info.docs`. */
    docs?: {
        apiReference?: string
        homepage?: string
        /** llms.txt URL for LLM-friendly docs. */
        llms?: string
    }
    /**
     * Extra middleware applied to the openapi route — handy for CORS or auth.
     */
    middleware?: RequestHandler | RequestHandler[]
    /**
     * Token-decimal override. The MPP spec requires `amount` to be in the
     * smallest denomination (e.g. for pathUSD with 6 decimals, $0.001 → "1000").
     * Defaults to 6 (Tempo TIP-20 stablecoins).
     */
    decimals?: number
}

/**
 * Mount the discovery endpoint on an existing Express app/Router. Adds:
 *
 *   GET <path>  →  application/json — OpenAPI 3.1 with x-payment-info
 *
 * Returns the same app for chaining.
 */
export function mountDiscovery(
    server: PaidMcpServer,
    app: Express | Router,
    options: DiscoveryOptions = {}
): Express | Router {
    const path = options.path ?? '/openapi.json'
    const middleware = normalizeMiddleware(options.middleware)
    const decimals = options.decimals ?? 6

    const handler: RequestHandler = (_req, res) => {
        const doc = buildOpenApi(server, options, decimals)
        res.set('Cache-Control', 'max-age=300')
        res.json(doc)
    }

    const get = app.get.bind(app) as (
        path: string,
        ...handlers: RequestHandler[]
    ) => unknown
    get(path, ...middleware, handler)

    return app
}

/**
 * Build the OpenAPI document programmatically. Useful if you want to embed
 * it in your own framework's response or pre-render it at build time.
 */
export function buildOpenApi(
    server: PaidMcpServer,
    options: DiscoveryOptions = {},
    decimals = 6
): Record<string, unknown> {
    const desc = server.describe()
    const xServiceInfo: Record<string, unknown> = {}
    if (options.categories && options.categories.length > 0) {
        xServiceInfo.categories = options.categories
    }
    if (options.docs && (options.docs.apiReference || options.docs.homepage || options.docs.llms)) {
        xServiceInfo.docs = options.docs
    }

    const paths: Record<string, unknown> = {}
    for (const tool of desc.tools) {
        const opPath = `/tools/${tool.name}`
        const operation = buildOperation(
            tool,
            desc.recipient,
            desc.currency,
            decimals
        )
        paths[opPath] = { post: operation }
    }

    const doc: Record<string, unknown> = {
        openapi: '3.1.0',
        info: {
            title: desc.name,
            version: desc.version,
            description: `Paid MCP tools served via mpp-mcp-gateway on Tempo ${desc.network}.`,
        },
        paths,
    }

    if (Object.keys(xServiceInfo).length > 0) {
        doc['x-service-info'] = xServiceInfo
    }
    if (options.baseUrl) {
        doc.servers = [{ url: options.baseUrl }]
    }

    return doc
}

/** @internal Build a single OpenAPI operation for a tool. */
function buildOperation(
    tool: {
        name: string
        description: string
        inputSchema: Record<string, z.ZodTypeAny>
        pricing?: PricingModel
    },
    recipient: `0x${string}`,
    currency: `0x${string}`,
    decimals: number
): Record<string, unknown> {
    const op: Record<string, unknown> = {
        operationId: tool.name,
        summary: tool.description,
        requestBody: {
            content: {
                'application/json': {
                    schema: zodObjectToJsonSchema(tool.inputSchema),
                },
            },
        },
        responses: {
            '200': {
                description: 'Successful response',
                content: {
                    'application/json': {
                        schema: { type: 'object' },
                    },
                },
            },
        },
    }

    // Free tool — no payment info, no 402.
    if (!tool.pricing) return op

    // Build x-payment-info offers based on pricing model.
    const offers = buildOffers(tool.pricing, currency, decimals)
    if (offers.length > 0) {
        op['x-payment-info'] = { offers }
            ; (op.responses as Record<string, unknown>)['402'] = {
                description: 'Payment Required',
            }
    }

    // Note: the recipient address is implicit (challenge will carry it),
    // but include as a convenience for explorers.
    op['x-mpp-mcp'] = {
        pricingType: tool.pricing.type,
        recipient,
    }

    return op
}

/**
 * @internal Build payment offers from a `PricingModel`. Per the MPP
 * discovery spec, `amount` is in the smallest denomination of the
 * currency. We support `tempo.charge` and `tempo.session` intents.
 */
function buildOffers(
    pricing: PricingModel,
    currency: `0x${string}`,
    decimals: number
): Array<Record<string, unknown>> {
    if (pricing.type === 'per-call') {
        return [
            {
                intent: 'charge',
                method: 'tempo',
                amount: usdToBaseUnits(pricing.amount, decimals),
                currency,
            },
        ]
    }
    if (pricing.type === 'tiered') {
        // Advertise the cheapest tier as the "best-case" offer plus a
        // descriptive note. Registries currently don't model dynamic prices
        // off the call counter, so a static-but-honest entry is fine.
        const cheapest = pricing.tiers.reduce((min, t) =>
            parseFloat(t.amount) < parseFloat(min.amount) ? t : min
        )
        return [
            {
                intent: 'charge',
                method: 'tempo',
                amount: usdToBaseUnits(cheapest.amount, decimals),
                currency,
                description: `Tiered pricing — best-case rate; first tier is $${pricing.tiers[0]!.amount}.`,
            },
        ]
    }
    if (pricing.type === 'session') {
        return [
            {
                intent: 'session',
                method: 'tempo',
                amount: usdToBaseUnits(pricing.amount, decimals),
                currency,
                description: `Per-${pricing.unitType} via on-chain payment channel.`,
            },
        ]
    }
    if (pricing.type === 'access-key') {
        const bounds: string[] = []
        if (pricing.validFor) bounds.push(`valid for ${pricing.validFor}`)
        if (pricing.maxCalls) bounds.push(`up to ${pricing.maxCalls} calls`)
        return [
            {
                intent: 'charge',
                method: 'tempo',
                amount: usdToBaseUnits(pricing.amount, decimals),
                currency,
                description: `Access key — pay once, ${bounds.join(', ')}.`,
            },
        ]
    }
    return []
}

/**
 * @internal Convert a USD decimal string ("0.001") to a base-units string
 * ("1000" with 6 decimals) per the MPP runtime/discovery format.
 */
function usdToBaseUnits(amount: string, decimals: number): string {
    const n = Number(amount)
    if (!Number.isFinite(n) || n < 0) {
        throw new ValidationError(
            `Invalid amount "${amount}" — must be a non-negative decimal string.`
        )
    }
    const scaled = Math.round(n * 10 ** decimals)
    return scaled.toString()
}

/**
 * @internal Convert a Zod inputSchema (object shape) to a JSON Schema for
 * use in OpenAPI's `requestBody.content`. We wrap the loose shape into
 * `z.object(...)` so Zod's built-in JSON Schema serializer sees a real
 * Zod schema.
 */
function zodObjectToJsonSchema(
    shape: Record<string, z.ZodTypeAny>
): Record<string, unknown> {
    if (Object.keys(shape).length === 0) {
        return { type: 'object', additionalProperties: false }
    }
    const obj = z.object(shape)
    const json = z.toJSONSchema(obj) as Record<string, unknown>
    // Strip $schema — OpenAPI wants pure JSON Schema fragments.
    if ('$schema' in json) delete json.$schema
    return json
}

/** @internal Normalize middleware option to an array. */
function normalizeMiddleware(
    m: DiscoveryOptions['middleware']
): RequestHandler[] {
    if (!m) return []
    return Array.isArray(m) ? m : [m]
}
