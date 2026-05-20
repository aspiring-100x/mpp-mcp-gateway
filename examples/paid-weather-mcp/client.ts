/**
 * Example: AI agent that uses the paid weather MCP server.
 *
 * Spawns the server as a subprocess over stdio, lists tools, calls a free
 * tool, and then calls two paid tools — signing the MPP payments on Tempo
 * testnet automatically.
 *
 * Prerequisites:
 *   1. Fund the agent wallet on Tempo testnet:
 *      cast rpc tempo_fundAddress <YOUR_ADDRESS> --rpc-url https://rpc.moderato.tempo.xyz
 *
 *   2. Set env vars:
 *      set AGENT_PRIVATE_KEY=0x...      (must have testnet pathUSD balance)
 *      set RECIPIENT_ADDRESS=0x...      (where payments go — server reads this too)
 *      set PAYMENT_SECRET_KEY=...       (any 32+ char random string, shared with server)
 *
 *   3. Run:
 *      npx tsx examples/paid-weather-mcp/client.ts
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { createPaidMcpClient } from '../../src/client.js'

const AGENT_KEY = (process.env.AGENT_PRIVATE_KEY ??
    // Anvil/Hardhat default test key #0 — DO NOT USE IN PRODUCTION.
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`

async function main() {
    console.log('🤖 AI Agent — Paid MCP Demo')
    console.log('───────────────────────────────────────────')

    const client = createPaidMcpClient({
        name: 'example-agent',
        version: '0.1.0',
        privateKey: AGENT_KEY,
        maxPerCall: '0.10',
        maxTotal: '5.00',
        network: 'testnet',
    })

    // Launch the server as a subprocess. It communicates over stdin/stdout.
    const serverPath = fileURLToPath(new URL('./server.ts', import.meta.url))
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', serverPath],
        env: {
            ...process.env,
            RECIPIENT_ADDRESS: process.env.RECIPIENT_ADDRESS ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            PAYMENT_SECRET_KEY: process.env.PAYMENT_SECRET_KEY ?? 'dev-secret-key-change-me-please',
        },
    })

    await client.connect(transport)
    console.log('✓ Connected to paid-weather MCP server\n')

    // 1. List tools
    const tools = await client.listTools()
    console.log('📋 Available tools:')
    for (const t of tools) console.log(`  • ${t.name} — ${t.description ?? ''}`)
    console.log()

    // 2. Free tool
    console.log('🆓 Calling free tool "ping"...')
    const ping = await client.callTool('ping')
    console.log(`   → ${ping.content[0]?.text}`)
    console.log(`   paid: ${ping.paid}`)
    console.log()

    // 3. Paid tool — triggers 402 then payment
    console.log('💸 Calling paid tool "get_weather" for San Francisco...')
    const weather = await client.callTool('get_weather', { city: 'San Francisco' })
    console.log(`   → ${weather.content[0]?.text}`)
    console.log(`   paid: ${weather.paid}`)
    if (weather.receipt) {
        console.log(`   tx:   ${weather.receipt.reference}`)
        console.log(`   at:   ${weather.receipt.timestamp}`)
    }
    console.log()

    // 4. Another paid tool
    console.log('💸 Calling paid tool "get_forecast" for Tokyo (3 days)...')
    const forecast = await client.callTool('get_forecast', { city: 'Tokyo', days: 3 })
    console.log(`   → ${forecast.content[0]?.text.replace(/\n/g, '\n     ')}`)
    console.log(`   paid: ${forecast.paid}`)
    if (forecast.receipt) {
        console.log(`   tx:   ${forecast.receipt.reference}`)
    }
    console.log()

    await client.close()
    console.log('✓ Done. Client disconnected.')
}

main().catch((err) => {
    console.error('❌ Error:', err)
    process.exit(1)
})
