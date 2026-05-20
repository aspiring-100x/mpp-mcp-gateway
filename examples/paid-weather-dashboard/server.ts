/**
 * Example: Paid Weather + Dashboard combined.
 *
 * One Express app hosts both:
 *   - POST/GET /mcp           — Streamable HTTP MCP transport
 *   - GET /api/{stats,tools,calls} — dashboard JSON API
 *   - GET /                   — the prebuilt dashboard UI (if available)
 *
 * Run:
 *   set PAYMENT_SECRET_KEY=some-32-char-random-string
 *   set RECIPIENT_ADDRESS=0xYourWallet
 *   npm run example:dashboard:server
 *
 * Make a few calls (any of the existing example clients work) and watch the
 * dashboard at http://localhost:3010/ update in real time.
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'

import { mountDashboard } from '../../src/dashboard.js'
import { mountDiscovery } from '../../src/discovery.js'
import { createPaidMcpServer } from '../../src/server.js'

const PORT = Number(process.env.PORT ?? 3010)
const RECIPIENT = (process.env.RECIPIENT_ADDRESS ??
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') as `0x${string}`
const SECRET = process.env.PAYMENT_SECRET_KEY ?? 'dev-secret-key-change-me-please'

const FAKE_WEATHER: Record<string, { tempF: number; condition: string }> = {
    'san francisco': { tempF: 64, condition: 'foggy' },
    tokyo: { tempF: 72, condition: 'clear' },
    london: { tempF: 58, condition: 'rainy' },
    'new york': { tempF: 76, condition: 'partly cloudy' },
}

const server = createPaidMcpServer({
    name: 'paid-weather-dashboard',
    version: '0.1.0',
    recipient: RECIPIENT,
    secretKey: SECRET,
    network: 'testnet',
    callLogSize: 500,
    tools: [
        {
            name: 'get_weather',
            description: 'Per-call ($0.001) — best for one-shot lookups.',
            inputSchema: { city: z.string() },
            pricing: { type: 'per-call', amount: '0.001' },
            handler: async ({ city }) => {
                const k = String(city).toLowerCase()
                const data = FAKE_WEATHER[k]
                if (!data) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No weather data for "${city}".`,
                            },
                        ],
                    }
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Weather in ${city}: ${data.tempF}°F, ${data.condition}`,
                        },
                    ],
                }
            },
        },
        {
            name: 'day_pass',
            description: 'Access-key ($0.005 / 5 calls) — buy a daily forecast bundle.',
            inputSchema: { city: z.string() },
            pricing: {
                type: 'access-key',
                amount: '0.005',
                maxCalls: 5,
                validFor: '1d',
            },
            handler: async ({ city }) => ({
                content: [{ type: 'text', text: `Forecast for ${city}: 75°F sunny.` }],
            }),
        },
        {
            name: 'ping',
            description: 'Free liveness check.',
            inputSchema: {},
            handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
        },
    ],
})

// One transport per session.
const transports = new Map<string, StreamableHTTPServerTransport>()

const app = createMcpExpressApp({ host: '127.0.0.1' })
app.use(express.json())

app.all('/mcp', async (req, res) => {
    const sessionId = req.header('mcp-session-id') ?? undefined
    let transport = sessionId ? transports.get(sessionId) : undefined

    if (!transport) {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
                transports.set(id, transport!)
            },
        })
        transport.onclose = () => {
            const id = transport!.sessionId
            if (id) transports.delete(id)
        }
        await server.server.connect(transport)
    }

    await transport.handleRequest(req, res, req.body)
})

// Dashboard JSON API.
mountDashboard(server, app)

// Service discovery — registries crawl /openapi.json automatically.
mountDiscovery(server, app, {
    baseUrl: process.env.PUBLIC_BASE_URL,
    categories: ['data'],
    docs: {
        homepage: 'https://github.com/your-org/your-repo',
    },
})

// Static dashboard UI (if it's been built).
const dashboardDist = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../dashboard/dist'
)
if (existsSync(dashboardDist)) {
    app.use(express.static(dashboardDist))
    console.error(`  dashboard UI: file://${dashboardDist} → http://localhost:${PORT}/`)
} else {
    console.error(
        `  (dashboard UI not built — run 'cd dashboard && npm install && npm run build' to enable it)`
    )
}

app.listen(PORT, () => {
    console.error('▶ paid-weather-dashboard server')
    console.error(`  endpoint:    http://localhost:${PORT}/mcp`)
    console.error(`  api:         http://localhost:${PORT}/api/{stats,tools,calls}`)
    console.error(`  openapi:     http://localhost:${PORT}/openapi.json`)
    console.error(`  recipient:   ${RECIPIENT}`)
    console.error(
        `  tools:       ${server
            .listTools()
            .map((t) => `${t.name}${t.price ? ` ($${t.price})` : ' (free)'}`)
            .join(', ')}`
    )
})
