/**
 * MPP-gated Peer Cash MCP tools.
 *
 * The inner Peer Cash server only returns live reads and unsigned Base USDC
 * transaction plans. MPP revenue settles to the operator on Tempo; see
 * revenue.ts for the separate, operator-controlled cash-out lifecycle.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPeerCashServer } from 'peer-cash-mcp'
import { z } from 'zod'
import { createPaidMcpServer } from '../../src/server.js'

const PATH_USD = '0x20c0000000000000000000000000000000000000' as const

const recipient = process.env.RECIPIENT_ADDRESS as `0x${string}` | undefined
const secretKey = process.env.PAYMENT_SECRET_KEY

if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    throw new Error(
        'RECIPIENT_ADDRESS must be the operator wallet that receives MPP revenue'
    )
}
if (!secretKey || secretKey.length < 32) {
    throw new Error('PAYMENT_SECRET_KEY must contain at least 32 characters')
}

const [peerClientTransport, peerServerTransport] =
    InMemoryTransport.createLinkedPair()
const peerServer = createPeerCashServer({ environment: 'production' })
const peerClient = new Client({
    name: 'paid-peer-cash-proxy',
    version: '0.1.0',
})

await Promise.all([
    peerServer.connect(peerServerTransport),
    peerClient.connect(peerClientTransport),
])

const proxy = async (name: string, args: Record<string, unknown>) => {
    const result = await peerClient.callTool({ name, arguments: args })
    if (
        !Array.isArray(result.content) ||
        result.content.some(
            (part) =>
                !part ||
                typeof part !== 'object' ||
                !('type' in part) ||
                part.type !== 'text' ||
                !('text' in part) ||
                typeof part.text !== 'string'
        )
    ) {
        throw new Error(`${name} returned an unsupported non-text MCP result`)
    }

    return {
        content: result.content.map((part) => ({
            type: 'text' as const,
            text: part.text,
        })),
        ...(result.isError === true ? { isError: true } : {}),
    }
}

const positiveBaseUnits = z
    .string()
    .regex(/^[1-9]\d*$/, 'Use positive base units')
const transactionHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/)
const depositId = z.string().regex(/^0x[a-fA-F0-9]{40}_[0-9]+$/)
const payee = z.union([
    z.string().min(1),
    z.object({ offchainId: z.string().min(1) }).passthrough(),
])
const receiveLeg = z.union([
    z.object({
        platform: z.string().min(1),
        currency: z.string().min(3),
        payee,
    }),
    z.object({
        platform: z.string().min(1),
        currencies: z.array(z.string().min(3)).min(1),
        payee,
    }),
])

const server = createPaidMcpServer({
    name: 'paid-peer-cash',
    version: '0.1.0',
    recipient,
    secretKey,
    network: 'mainnet',
    currency: PATH_USD,
    tools: [
        {
            name: 'peer_cash_capabilities',
            description:
                'Discover current Peer Cash payout rails and currencies.',
            inputSchema: { includeRelaySources: z.boolean().optional() },
            handler: (args) => proxy('peer_cash_capabilities', args),
        },
        {
            name: 'peer_cash_estimate',
            description:
                'Estimate fiat received for a Base USDC amount. Costs $0.001.',
            inputSchema: {
                amount: positiveBaseUnits.describe(
                    'Base USDC amount in 6-decimal base units'
                ),
                currency: z.string().min(3).describe('ISO 4217 fiat currency'),
                platform: z.string().min(1).optional(),
            },
            pricing: { type: 'per-call', amount: '0.001' },
            handler: (args) => proxy('peer_cash_estimate', args),
        },
        {
            name: 'peer_cash_prepare',
            description:
                'Prepare unsigned Base USDC cash-out transactions. Costs $0.005.',
            inputSchema: {
                amount: positiveBaseUnits.describe(
                    'Base USDC amount in 6-decimal base units'
                ),
                receive: z.union([receiveLeg, z.array(receiveLeg).min(1)]),
            },
            pricing: { type: 'per-call', amount: '0.005' },
            handler: (args) => proxy('peer_cash_prepare', args),
        },
        {
            name: 'peer_cash_finalize',
            description:
                'Resolve a confirmed createDeposit receipt. Costs $0.001.',
            inputSchema: { transactionHash },
            pricing: { type: 'per-call', amount: '0.001' },
            handler: (args) => proxy('peer_cash_finalize', args),
        },
        {
            name: 'peer_cash_prepare_access_policy',
            description:
                'Prepare an unsigned restricted-rail access policy. Costs $0.001.',
            inputSchema: { depositId },
            pricing: { type: 'per-call', amount: '0.001' },
            handler: (args) => proxy('peer_cash_prepare_access_policy', args),
        },
        {
            name: 'peer_cash_order',
            description: 'Read the current Peer Cash order state.',
            inputSchema: { depositId },
            handler: (args) => proxy('peer_cash_order', args),
        },
    ],
})

const closeInnerServer = async () => {
    await peerClient.close()
    await peerServer.close()
}

process.once('SIGINT', () => void closeInnerServer())
process.once('SIGTERM', () => void closeInnerServer())

console.error('Paid Peer Cash MCP server starting on stdio')
console.error(`MPP revenue recipient: ${recipient}`)
console.error('Settlement: Tempo mainnet pathUSD')

await server.startStdio()
