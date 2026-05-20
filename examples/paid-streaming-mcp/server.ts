/**
 * Example: Paid Streaming MCP Server (session pricing).
 *
 * Demonstrates the second pricing primitive — pay-as-you-go via an on-chain
 * payment channel. The client opens an escrow once, signs incremental
 * vouchers per call, and the server settles on close. Best for streaming
 * tools where one-shot per-call settlement would be too slow or expensive.
 *
 * Run:
 *   set PAYMENT_SECRET_KEY=some-32-char-random-string
 *   set RECIPIENT_ADDRESS=0xYourWallet
 *   npm run example:streaming:server
 *
 * Then in another terminal:
 *   npm run example:streaming:client
 */

import { createPaidMcpServer } from '../../src/server.js'
import { z } from 'zod'

const RECIPIENT = (process.env.RECIPIENT_ADDRESS ??
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') as `0x${string}`
const SECRET = process.env.PAYMENT_SECRET_KEY ?? 'dev-secret-key-change-me-please'

const server = createPaidMcpServer({
    name: 'paid-streaming',
    version: '0.1.0',
    recipient: RECIPIENT,
    secretKey: SECRET,
    network: 'testnet',

    tools: [
        {
            name: 'think',
            description:
                'Simulates an "AI thought" that takes N seconds. Pay $0.0005 per call via session.',
            inputSchema: {
                topic: z.string().describe('What to think about'),
                seconds: z.number().int().min(1).max(10).default(2),
            },
            // Session pricing: per-call here is $0.0005, but unitType lets
            // an agent know roughly what "a unit" represents — useful when
            // the same channel funds many calls.
            pricing: {
                type: 'session',
                amount: '0.0005',
                unitType: 'request',
                suggestedDeposit: '0.05',
            },
            handler: async ({ topic, seconds }) => {
                const n = Math.min(10, Math.max(1, Number(seconds ?? 2)))
                await new Promise((r) => setTimeout(r, n * 1000))
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Spent ${n}s thinking about "${topic}". Conclusion: it depends.`,
                        },
                    ],
                }
            },
        },
        {
            name: 'tick',
            description: 'Lightweight "next chunk" call against the same channel ($0.0001).',
            inputSchema: {},
            pricing: {
                type: 'session',
                amount: '0.0001',
                unitType: 'request',
                suggestedDeposit: '0.05',
            },
            handler: async () => ({
                content: [{ type: 'text', text: '...next bit of progress...' }],
            }),
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

console.error('▶ paid-streaming-mcp server starting on stdio transport')
console.error(`  recipient: ${RECIPIENT}`)
console.error(`  network:   Tempo Testnet (Moderato)`)
console.error(`  pricing:   session-based (open channel once, voucher per call)`)
console.error(
    `  tools:     ${server
        .listTools()
        .map((t) => `${t.name}${t.price ? ` ($${t.price}/call)` : ' (free)'}`)
        .join(', ')}`
)

await server.startStdio()
