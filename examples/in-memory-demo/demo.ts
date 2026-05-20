/**
 * In-memory demo — proves the MPP 402 challenge round-trip works end-to-end.
 *
 * Both the paid MCP server and the client run in the same process, connected
 * via an in-memory transport. The free `ping` tool returns directly. Paid
 * tools will return an MCP error with code -32042 (PaymentRequired) on the
 * first call; the client then attempts to sign a payment, which will fail
 * without funded testnet wallets — but we'll see the challenge flow in action.
 *
 * Run:
 *   npx tsx examples/in-memory-demo/demo.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { tempo } from 'mppx/client'
import { McpClient } from 'mppx/mcp-sdk/client'
import { privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'

import { createPaidMcpServer } from '../../src/server.js'

async function main() {
    console.log('🔧 In-memory MPP + MCP demo\n')

    // ---- SERVER ----
    const server = createPaidMcpServer({
        name: 'in-memory-demo',
        version: '0.0.1',
        recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        secretKey: 'demo-secret-key-not-for-production-use',
        network: 'testnet',
        tools: [
            {
                name: 'ping',
                description: 'Free tool that echoes "pong".',
                inputSchema: {},
                handler: async () => ({
                    content: [{ type: 'text', text: 'pong' }],
                }),
            },
            {
                name: 'premium_echo',
                description: 'Paid tool that echoes your message. $0.01 per call.',
                inputSchema: { message: z.string() },
                pricing: { type: 'per-call', amount: '0.01' },
                handler: async ({ message }) => ({
                    content: [{ type: 'text', text: `ECHO: ${message}` }],
                }),
            },
        ],
    })

    // ---- TRANSPORT ----
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    // Connect server to the server side of the pair
    await server.server.connect(serverTransport)

    // ---- CLIENT ----
    // Use a throwaway test key. No real funds involved — we'll see the 402
    // challenge arrive; actually submitting the signed tx requires testnet
    // pathUSD balance, so the paid call will error at chain-submit time but
    // the challenge/credential flow is observable.
    const agentKey =
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
    const account = privateKeyToAccount(agentKey)

    const rawClient = new Client({ name: 'demo-agent', version: '0.0.1' })
    const client = McpClient.wrap(rawClient, {
        methods: [...tempo({ account })],
    })

    await rawClient.connect(clientTransport)
    console.log('✓ Connected client ↔ server via in-memory transport\n')

    // ---- LIST TOOLS ----
    const tools = await rawClient.listTools()
    console.log('📋 Tools advertised by server:')
    for (const t of tools.tools) console.log(`  • ${t.name} — ${t.description ?? ''}`)
    console.log()

    // ---- FREE TOOL ----
    console.log('🆓 Calling "ping" (free)...')
    const ping = await client.callTool({ name: 'ping', arguments: {} })
    const pingText = (ping.content as Array<{ type: string; text?: string }>)?.[0]?.text
    console.log(`   → ${pingText}`)
    console.log(`   receipt: ${ping.receipt ? JSON.stringify(ping.receipt) : 'none'}`)
    console.log()

    // ---- PAID TOOL ----
    // This WILL attempt a real onchain tx submission. Without a funded wallet
    // on Tempo testnet, this will fail at the signing or broadcast stage —
    // but the MPP 402 challenge/credential handshake runs first, which is
    // what we're demonstrating.
    console.log('💸 Calling "premium_echo" (paid, $0.01)...')
    console.log('   (This attempts a real Tempo testnet transaction.)')
    console.log('   (Fund your wallet first via:')
    console.log(
        `   cast rpc tempo_fundAddress ${account.address} --rpc-url https://rpc.moderato.tempo.xyz)\n`
    )
    try {
        const result = await client.callTool({
            name: 'premium_echo',
            arguments: { message: 'hello from the agent' },
        })
        const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text
        console.log(`   → ${text}`)
        console.log(`   paid: ${!!result.receipt}`)
        if (result.receipt) {
            console.log(`   tx: ${result.receipt.reference}`)
            console.log(`   time: ${result.receipt.timestamp}`)
        }
    } catch (err) {
        const e = err as Error
        console.log(`   ✗ Payment flow error: ${e.message}`)
        console.log('   (Expected if the wallet is unfunded or RPC is unreachable.)')
    }

    console.log()
    console.log('📊 Server stats:')
    console.log(JSON.stringify(server.getStats(), null, 2))

    await rawClient.close()
}

main().catch((e) => {
    console.error('Fatal:', e)
    process.exit(1)
})
