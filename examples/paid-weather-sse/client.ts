/**
 * Example: AI agent client over the legacy SSE transport.
 *
 * Connects to the SSE server (run it first in another terminal):
 *   npm run example:sse:server
 *
 * Then:
 *   npm run example:sse:client
 *
 * Note: SSE is deprecated in the MCP spec — for new servers use the
 * Streamable HTTP example. SSE remains useful when integrating with
 * existing clients that haven't migrated yet.
 *
 * Prerequisites for paid calls:
 *   1. Fund the agent wallet on Tempo testnet:
 *      cast rpc tempo_fundAddress <YOUR_ADDRESS> --rpc-url https://rpc.moderato.tempo.xyz
 *   2. Set env vars:
 *      set AGENT_PRIVATE_KEY=0x...           (must have testnet pathUSD)
 *      set MCP_SSE_URL=http://localhost:3011/sse   (optional, default shown)
 */

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

import { createPaidMcpClient } from '../../src/client.js'

const URL_DEFAULT = 'http://localhost:3011/sse'
const AGENT_KEY = (process.env.AGENT_PRIVATE_KEY ??
    // Anvil/Hardhat default test key #0 — DO NOT USE IN PRODUCTION.
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`

async function main() {
    console.log('🤖 AI Agent — SSE Demo (legacy transport)')
    console.log('───────────────────────────────────────────')

    const client = createPaidMcpClient({
        name: 'sse-example-agent',
        version: '0.1.0',
        privateKey: AGENT_KEY,
        maxPerCall: '0.10',
        maxTotal: '5.00',
        network: 'testnet',
    })

    const url = new URL(process.env.MCP_SSE_URL ?? URL_DEFAULT)
    const transport = new SSEClientTransport(url)

    await client.connect(transport)
    console.log(`✓ Connected to ${url.toString()}\n`)

    // 1. List tools
    const tools = await client.listTools()
    console.log('📋 Available tools:')
    for (const t of tools) console.log(`  • ${t.name} — ${t.description ?? ''}`)
    console.log()

    // 2. Free tool
    console.log('🆓 Calling free tool "ping"...')
    const ping = await client.callTool('ping')
    console.log(`   → ${ping.content[0]?.text}`)
    console.log(`   paid: ${ping.paid}\n`)

    // 3. Paid tool — triggers 402 then payment
    console.log('💸 Calling paid tool "get_weather" for London...')
    const weather = await client.callTool('get_weather', { city: 'London' })
    console.log(`   → ${weather.content[0]?.text}`)
    console.log(`   paid: ${weather.paid}`)
    if (weather.receipt) {
        console.log(`   tx:   ${weather.receipt.reference}`)
        console.log(`   at:   ${weather.receipt.timestamp}`)
    }
    console.log()

    // 4. Another paid tool
    console.log('💸 Calling paid tool "get_forecast" for New York (5 days)...')
    const forecast = await client.callTool('get_forecast', { city: 'New York', days: 5 })
    console.log(`   → ${forecast.content[0]?.text.replace(/\n/g, '\n     ')}`)
    console.log(`   paid: ${forecast.paid}`)
    if (forecast.receipt) {
        console.log(`   tx:   ${forecast.receipt.reference}`)
    }
    console.log()

    const spending = client.getSpending()
    console.log(
        `💼 Spend so far: $${spending.totalSpent.toFixed(6)} of $${spending.maxTotal.toFixed(2)} cap`
    )

    await client.close()
    console.log('\n✓ Done. Client disconnected.')
}

main().catch((err) => {
    console.error('❌ Error:', err)
    process.exit(1)
})
