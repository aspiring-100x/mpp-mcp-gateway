/**
 * Example: AI agent that uses session pricing.
 *
 * Spawns the streaming server as a subprocess. The first paid call opens
 * the on-chain escrow channel; subsequent paid calls ride on incremental
 * off-chain vouchers — sub-100ms latency after the channel is open, no
 * on-chain tx per call.
 *
 * Prerequisites:
 *   1. Fund the agent wallet on Tempo testnet:
 *      cast rpc tempo_fundAddress <YOUR_ADDRESS> --rpc-url https://rpc.moderato.tempo.xyz
 *
 *   2. Set env vars:
 *      set AGENT_PRIVATE_KEY=0x...
 *      set RECIPIENT_ADDRESS=0x...
 *      set PAYMENT_SECRET_KEY=any-32-char-random-string
 *
 *   3. Run:
 *      npm run example:streaming:client
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { createPaidMcpClient } from '../../src/client.js'

const AGENT_KEY = (process.env.AGENT_PRIVATE_KEY ??
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`

async function main() {
    console.log('🤖 AI Agent — Session Pricing Demo')
    console.log('───────────────────────────────────────────')

    const client = createPaidMcpClient({
        name: 'streaming-example-agent',
        version: '0.1.0',
        privateKey: AGENT_KEY,
        // Session-specific cap. Server suggests $0.05; we allow up to $0.10
        // so we'd accept either default.
        maxSessionDeposit: '0.10',
        // Per-call/total caps still apply.
        maxPerCall: '0.10',
        maxTotal: '5.00',
        network: 'testnet',
    })

    const serverPath = fileURLToPath(new URL('./server.ts', import.meta.url))
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', serverPath],
        env: {
            ...process.env,
            RECIPIENT_ADDRESS:
                process.env.RECIPIENT_ADDRESS ??
                '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            PAYMENT_SECRET_KEY:
                process.env.PAYMENT_SECRET_KEY ?? 'dev-secret-key-change-me-please',
        },
    })

    await client.connect(transport)
    console.log('✓ Connected to paid-streaming MCP server\n')

    const tools = await client.listTools()
    console.log('📋 Available tools:')
    for (const t of tools) console.log(`  • ${t.name} — ${t.description ?? ''}`)
    console.log()

    // First paid call opens the channel on-chain. Expect ~1s latency.
    console.log('🔓 Calling "think" (opens channel)...')
    const t0 = performance.now()
    const r1 = await client.callTool('think', { topic: 'physics', seconds: 1 })
    const dt1 = (performance.now() - t0).toFixed(0)
    console.log(`   → ${r1.content[0]?.text}`)
    console.log(`   paid: ${r1.paid} (${dt1}ms wall, includes 1s handler delay + channel open)`)
    if (r1.receipt) {
        console.log(`   tx:   ${r1.receipt.reference}`)
    }
    console.log()

    // Subsequent calls ride on the same channel via off-chain vouchers.
    // No new on-chain tx — just a signed voucher → server validates → done.
    for (const i of [1, 2, 3]) {
        const t = performance.now()
        const r = await client.callTool('tick')
        const dt = (performance.now() - t).toFixed(0)
        console.log(`💸 tick #${i}: ${r.content[0]?.text} (${dt}ms — voucher only)`)
    }

    console.log()
    const spending = client.getSpending()
    console.log(
        `💼 Cumulative voucher: $${spending.cumulativeVoucher.toFixed(6)} ` +
        `(of $${spending.maxSessionDeposit.toFixed(2)} channel deposit)`
    )

    await client.close()
    console.log('\n✓ Done. Channel remains open on-chain until the recipient settles.')
}

main().catch((err) => {
    console.error('❌ Error:', err)
    process.exit(1)
})
