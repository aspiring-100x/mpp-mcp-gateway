/**
 * Example: AI agent that uses access-key pricing.
 *
 * Spawns the subscription server as a subprocess. The agent pays once for
 * each tool's "subscription," receives an access key, and gets free calls
 * against it until the key expires or runs out.
 *
 * Prerequisites:
 *   1. Fund the agent wallet on Tempo testnet:
 *      cast rpc tempo_fundAddress <YOUR_ADDRESS> --rpc-url https://rpc.moderato.tempo.xyz
 *   2. Set env vars:
 *      set AGENT_PRIVATE_KEY=0x...
 *      set RECIPIENT_ADDRESS=0x...
 *      set PAYMENT_SECRET_KEY=any-32-char-random-string
 *
 *   3. Run:
 *      npm run example:subscription:client
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { createPaidMcpClient } from '../../src/client.js'

const AGENT_KEY = (process.env.AGENT_PRIVATE_KEY ??
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`

async function main() {
    console.log('🤖 AI Agent — Access-Key Pricing Demo')
    console.log('───────────────────────────────────────────')

    const client = createPaidMcpClient({
        name: 'subscription-example-agent',
        version: '0.1.0',
        privateKey: AGENT_KEY,
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
    console.log('✓ Connected to paid-subscription MCP server\n')

    // First call pays $0.005 and mints a 5-call/1-day key.
    console.log('💸 Calling "day_pass_quote" (pays $0.005, mints a key)...')
    const r1 = await client.callTool('day_pass_quote', { seed: 1 })
    console.log(`   → "${r1.content[0]?.text}"`)
    console.log(`   paid: ${r1.paid}`)
    if (r1.receipt) console.log(`   tx:   ${r1.receipt.reference}`)
    if (r1.accessKey) {
        console.log(
            `   key:  ${r1.accessKey.key.slice(0, 24)}...  ` +
            `remaining=${r1.accessKey.remainingCalls}, ` +
            `expires=${r1.accessKey.expiresAt}`
        )
    }
    console.log()

    // Three follow-up calls — all free against the cached key.
    for (const i of [2, 3, 4]) {
        const r = await client.callTool('day_pass_quote', { seed: i })
        console.log(
            `🎟️  call #${i}: "${r.content[0]?.text}" ` +
            `(paid=${r.paid}, remaining=${r.accessKey?.remainingCalls})`
        )
    }
    console.log()

    // The 5th call drains the key (1 used + 4 here = 5 total), so the next
    // call should issue a new payment.
    console.log('🔁 5th call (should drain the key)...')
    const r5 = await client.callTool('day_pass_quote', { seed: 5 })
    console.log(
        `   → "${r5.content[0]?.text}"  paid=${r5.paid}, ` +
        `remaining=${r5.accessKey?.remainingCalls}`
    )
    console.log()

    console.log('🔁 6th call (key was drained — pays again)...')
    const r6 = await client.callTool('day_pass_quote', { seed: 6 })
    console.log(`   → "${r6.content[0]?.text}"`)
    console.log(`   paid: ${r6.paid}`)
    if (r6.receipt) console.log(`   tx:   ${r6.receipt.reference}`)
    if (r6.accessKey) {
        console.log(
            `   new key: ${r6.accessKey.key.slice(0, 24)}...  ` +
            `remaining=${r6.accessKey.remainingCalls}`
        )
    }
    console.log()

    console.log('💼 Cached keys at end of session:')
    for (const [tool, info] of Object.entries(client.getAccessKeys())) {
        console.log(`   • ${tool}: ${info.key.slice(0, 24)}...  remaining=${info.remainingCalls}`)
    }
    console.log()

    const spending = client.getSpending()
    console.log(`Total on-chain spend: $${spending.totalSpent.toFixed(6)}`)
    console.log('  (would have been $0.030 with per-call pricing for 6 calls)')

    await client.close()
    console.log('\n✓ Done.')
}

main().catch((err) => {
    console.error('❌ Error:', err)
    process.exit(1)
})
