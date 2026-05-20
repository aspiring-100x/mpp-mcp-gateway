/**
 * Example: Paid Weather MCP Server — Streamable HTTP transport.
 *
 * Listens on :3010 by default. The MCP SDK's Streamable HTTP transport
 * speaks JSON-RPC over `POST /mcp` for client→server messages and over
 * `GET /mcp` (Server-Sent Events) for server→client messages — all on a
 * single endpoint, with optional session affinity via the `Mcp-Session-Id`
 * header.
 *
 * Run:
 *   set PAYMENT_SECRET_KEY=some-32-char-random-string
 *   set RECIPIENT_ADDRESS=0xYourWallet
 *   npm run example:http:server
 *
 * Then in another terminal:
 *   npm run example:http:client
 *
 * Or test with curl:
 *   curl -X POST http://localhost:3010/mcp \
 *     -H 'Content-Type: application/json' \
 *     -H 'Accept: application/json, text/event-stream' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import express from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { createPaidMcpServer } from '../../src/server.js'

const PORT = Number(process.env.PORT ?? 3010)
const RECIPIENT = (process.env.RECIPIENT_ADDRESS ??
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') as `0x${string}`
const SECRET = process.env.PAYMENT_SECRET_KEY ?? 'dev-secret-key-change-me-please'

// Same fake "weather DB" the stdio example uses, so all transports show
// identical behavior — only the wire format differs.
const FAKE_WEATHER: Record<string, { tempF: number; condition: string }> = {
    'san francisco': { tempF: 64, condition: 'foggy' },
    tokyo: { tempF: 72, condition: 'clear' },
    london: { tempF: 58, condition: 'rainy' },
    'new york': { tempF: 76, condition: 'partly cloudy' },
}

const server = createPaidMcpServer({
    name: 'paid-weather-http',
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

// One transport per session. The SDK's Streamable HTTP server transport is
// stateful by default — it issues a session id, the client echoes it back
// on every subsequent request, and we route to the matching transport.
const transports = new Map<string, StreamableHTTPServerTransport>()

// `createMcpExpressApp` enables localhost DNS-rebinding protection for us.
const app = createMcpExpressApp({ host: '127.0.0.1' })
app.use(express.json())

app.all('/mcp', async (req, res) => {
    const sessionId = req.header('mcp-session-id') ?? undefined

    let transport = sessionId ? transports.get(sessionId) : undefined

    if (!transport) {
        // First request from this client — create a fresh transport, attach
        // it to the MCP server, and remember it by session id.
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
                transports.set(id, transport!)
                console.error(`▶ session opened: ${id}`)
            },
        })

        transport.onclose = () => {
            const id = transport!.sessionId
            if (id) transports.delete(id)
            console.error(`✕ session closed: ${id ?? '(no id)'}`)
        }

        await server.server.connect(transport)
    }

    await transport.handleRequest(req, res, req.body)
})

app.listen(PORT, () => {
    console.error('▶ paid-weather-http server')
    console.error(`  endpoint:  http://localhost:${PORT}/mcp`)
    console.error(`  recipient: ${RECIPIENT}`)
    console.error(`  network:   Tempo Testnet (Moderato)`)
    console.error(
        `  tools:     ${server
            .listTools()
            .map((t) => `${t.name}${t.price ? ` ($${t.price})` : ' (free)'}`)
            .join(', ')}`
    )
})
