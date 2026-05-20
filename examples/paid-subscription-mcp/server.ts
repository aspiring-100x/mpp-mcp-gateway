/**
 * Example: Paid Subscription MCP Server (access-key pricing).
 *
 * Demonstrates the third pricing primitive — pay-once, then call up to N
 * times within a validity window. Best for "buy a day pass" or "buy 1000
 * calls" UX where each call is independent and there's no on-chain channel
 * to manage.
 *
 * Run:
 *   set PAYMENT_SECRET_KEY=some-32-char-random-string
 *   set RECIPIENT_ADDRESS=0xYourWallet
 *   npm run example:subscription:server
 *
 * Then in another terminal:
 *   npm run example:subscription:client
 */

import { z } from 'zod'
import { createPaidMcpServer } from '../../src/server.js'

const RECIPIENT = (process.env.RECIPIENT_ADDRESS ??
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') as `0x${string}`
const SECRET = process.env.PAYMENT_SECRET_KEY ?? 'dev-secret-key-change-me-please'

const FAKE_QUOTES = [
    'The market is mood, not math.',
    'Time in beats timing.',
    'Bonds eat dollars when no one is looking.',
    'A consensus trade has a way of becoming a contrarian one in slow motion.',
    'Every chart is a Rorschach test for the trader holding it.',
]

const server = createPaidMcpServer({
    name: 'paid-subscription',
    version: '0.1.0',
    recipient: RECIPIENT,
    secretKey: SECRET,
    network: 'testnet',

    tools: [
        {
            name: 'day_pass_quote',
            description:
                'Get a market wisdom quote. $0.005 buys a key good for 5 calls or 1 day, whichever comes first.',
            inputSchema: {
                seed: z.number().int().optional().describe('Optional deterministic seed.'),
            },
            pricing: {
                type: 'access-key',
                amount: '0.005',
                validFor: '1d',
                maxCalls: 5,
            },
            handler: async ({ seed }) => {
                const i =
                    typeof seed === 'number'
                        ? Math.abs(seed) % FAKE_QUOTES.length
                        : Math.floor(Math.random() * FAKE_QUOTES.length)
                return {
                    content: [{ type: 'text', text: FAKE_QUOTES[i]! }],
                }
            },
        },
        {
            name: 'time_only_pass',
            description:
                'Unlimited calls, $0.01 buys 5 minutes of access (no call cap).',
            inputSchema: {},
            pricing: {
                type: 'access-key',
                amount: '0.01',
                validFor: '5m',
            },
            handler: async () => ({
                content: [
                    { type: 'text', text: `Server clock: ${new Date().toISOString()}` },
                ],
            }),
        },
        {
            name: 'call_pack',
            description:
                'Unlimited time, $0.005 buys 100 calls (best for batch use).',
            inputSchema: {
                topic: z.string().describe('Topic to summarize'),
            },
            pricing: {
                type: 'access-key',
                amount: '0.005',
                maxCalls: 100,
            },
            handler: async ({ topic }) => ({
                content: [
                    {
                        type: 'text',
                        text: `Brief on "${topic}": this is a stub example response.`,
                    },
                ],
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

console.error('▶ paid-subscription-mcp server starting on stdio transport')
console.error(`  recipient: ${RECIPIENT}`)
console.error(`  network:   Tempo Testnet (Moderato)`)
console.error(`  pricing:   access-key (pay once, call many)`)
console.error(
    `  tools:     ${server
        .listTools()
        .map((t) => `${t.name}${t.price ? ` ($${t.price} upfront)` : ' (free)'}`)
        .join(', ')}`
)

await server.startStdio()
