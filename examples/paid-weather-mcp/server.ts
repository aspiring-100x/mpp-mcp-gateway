/**
 * Example: Paid Weather MCP Server
 *
 * Runs over stdio. An AI agent (or the companion client) connects, discovers
 * tools, and pays for each call in pathUSD on Tempo testnet.
 *
 * Run:
 *   set PAYMENT_SECRET_KEY=some-32-char-random-string
 *   set RECIPIENT_ADDRESS=0xYourWallet
 *   npx tsx examples/paid-weather-mcp/server.ts
 *
 * Or from the client side:
 *   npx tsx examples/paid-weather-mcp/client.ts
 * (the client will spawn this server via stdio)
 */

import { createPaidMcpServer } from '../../src/server.js'
import { z } from 'zod'

const RECIPIENT = (process.env.RECIPIENT_ADDRESS ??
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') as `0x${string}`
const SECRET = process.env.PAYMENT_SECRET_KEY ?? 'dev-secret-key-change-me-please'

// Fake weather "database" for the demo. In production this would be a real API.
const FAKE_WEATHER: Record<string, { tempF: number; condition: string }> = {
    'san francisco': { tempF: 64, condition: 'foggy' },
    tokyo: { tempF: 72, condition: 'clear' },
    london: { tempF: 58, condition: 'rainy' },
    'new york': { tempF: 76, condition: 'partly cloudy' },
}

const server = createPaidMcpServer({
    name: 'paid-weather',
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
            description: 'Get a 7-day forecast. Costs $0.005 per call.',
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
                        { type: 'text', text: `${n}-day forecast for ${city}:\n${lines.join('\n')}` },
                    ],
                }
            },
        },
        {
            name: 'ping',
            description: 'Free tool — returns "pong".',
            inputSchema: {},
            // no pricing → free tool
            handler: async () => ({
                content: [{ type: 'text', text: 'pong' }],
            }),
        },
    ],
})

// Log to stderr so we don't corrupt the stdio protocol on stdout.
console.error('▶ paid-weather-mcp server starting on stdio transport')
console.error(`  recipient: ${RECIPIENT}`)
console.error(`  network:   Tempo Testnet (Moderato)`)
console.error(`  tools:     ${server.listTools().map((t) => `${t.name}${t.price ? ` ($${t.price})` : ' (free)'}`).join(', ')}`)

await server.startStdio()
