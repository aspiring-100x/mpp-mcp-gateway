/**
 * Example: Paid Weather MCP Server — legacy SSE transport.
 *
 * The SSE transport is deprecated in favor of Streamable HTTP, but plenty of
 * existing MCP clients still use it (especially older Claude Desktop builds
 * and reference clients), so it's useful to support during the migration
 * window.
 *
 * Wire shape:
 *   GET  /sse              → server opens a Server-Sent Events stream.
 *                            First event names a `messages?sessionId=X`
 *                            endpoint the client should POST to.
 *   POST /messages?sessionId=X
 *                          → client→server JSON-RPC messages.
 *
 * Run:
 *   set PAYMENT_SECRET_KEY=some-32-char-random-string
 *   set RECIPIENT_ADDRESS=0xYourWallet
 *   npm run example:sse:server
 *
 * Then in another terminal:
 *   npm run example:sse:client
 */

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import express from 'express'
import { z } from 'zod'

import { createPaidMcpServer } from '../../src/server.js'

const PORT = Number(process.env.PORT ?? 3011)
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
    name: 'paid-weather-sse',
    version: '0.1.0',
    recipient: RECIPIENT,
    secretKey: SECRET,
    network: 'testnet',
    tools: [
        {
            name: 'get_weather',
            description: 'Get current weather for a city. Costs $0.001 per call.',
            inputSchema: {
                city: z.string().describe('City name, e.g. "San Francisco"'),
            },
            pricing: { type: 'per-call', amount: '0.001' },
            handler: async ({ city }) => {
                const key = String(city).toLowerCase()
                const data = FAKE_WEATHER[key]
                if (!data) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No weather data for "${city}". Try: ${Object.keys(FAKE_WEATHER).join(', ')}`,
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
                    data,
                }
            },
        },
        {
            name: 'get_forecast',
            description: 'Get an N-day forecast (1-14). Costs $0.005 per call.',
            inputSchema: {
                city: z.string().describe('City name'),
                days: z.number().int().min(1).max(14).default(7),
            },
            pricing: { type: 'per-call', amount: '0.005' },
            handler: async ({ city, days }) => {
                const n = Number(days ?? 7)
                const lines = Array.from({ length: n }, (_, i) => {
                    const t = 60 + Math.floor(Math.random() * 20)
                    return `Day ${i + 1}: ${t}°F`
                })
                return {
                    content: [
                        {
                            type: 'text',
                            text: `${n}-day forecast for ${city}:\n${lines.join('\n')}`,
                        },
                    ],
                }
            },
        },
        {
            name: 'ping',
            description: 'Free liveness check.',
            inputSchema: {},
            handler: async () => ({
                content: [{ type: 'text', text: 'pong' }],
            }),
        },
    ],
})

// SSE is fundamentally session-oriented: every connected client owns one
// long-lived GET /sse stream and POSTs incoming messages to /messages with
// its sessionId. We track transports by id so /messages can route correctly.
const transports = new Map<string, SSEServerTransport>()

const app = createMcpExpressApp({ host: '127.0.0.1' })

app.get('/sse', async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res)
    transports.set(transport.sessionId, transport)
    transport.onclose = () => {
        transports.delete(transport.sessionId)
        console.error(`✕ SSE session closed: ${transport.sessionId}`)
    }
    await server.server.connect(transport)
    console.error(`▶ SSE session opened: ${transport.sessionId}`)
})

app.post('/messages', express.json(), async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined
    if (!sessionId) {
        res.status(400).send('Missing sessionId query parameter')
        return
    }
    const transport = transports.get(sessionId)
    if (!transport) {
        res.status(404).send(`No active session: ${sessionId}`)
        return
    }
    await transport.handlePostMessage(req, res, req.body)
})

app.listen(PORT, () => {
    console.error('▶ paid-weather-sse server (legacy transport)')
    console.error(`  sse stream:  http://localhost:${PORT}/sse`)
    console.error(`  messages:    http://localhost:${PORT}/messages?sessionId=...`)
    console.error(`  recipient:   ${RECIPIENT}`)
    console.error(`  network:     Tempo Testnet (Moderato)`)
    console.error(
        `  tools:       ${server
            .listTools()
            .map((t) => `${t.name}${t.price ? ` ($${t.price})` : ' (free)'}`)
            .join(', ')}`
    )
})
