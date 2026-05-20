/**
 * Test helpers.
 *
 * Spins up a paid MCP server + a PaidMcpClient connected by the MCP SDK's
 * in-memory transport, so tests don't need a network round-trip to the MCP
 * layer. Payment verification still hits the real Tempo testnet because
 * mppx's tempo charge intent always submits a transaction — tests that
 * assert a successful paid flow execute real chain txs (~1s latency).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
    createPaidMcpClient,
    createPaidMcpServer,
    PaidMcpClient,
    PaidMcpServer,
    PaidMcpServerConfig,
    PaidMcpClientConfig,
} from '../src/index.js'

/**
 * Anvil/Hardhat default test key #0. This wallet is pre-funded with test
 * stablecoins on Tempo testnet, which is what makes the paid-flow tests work
 * without a separate funding step.
 */
export const TEST_AGENT_KEY =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const

export const TEST_AGENT_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const

export const DEMO_SECRET = 'test-secret-key-not-for-production-use-ever'

/** Build a paid server with the given tools and start an in-memory pair. */
export async function makeConnectedPair(
    opts: {
        serverConfig?: Partial<PaidMcpServerConfig>
        clientConfig?: Partial<PaidMcpClientConfig>
        tools: PaidMcpServerConfig['tools']
    } = { tools: [] }
): Promise<{
    server: PaidMcpServer
    client: PaidMcpClient
    rawClient: Client
    dispose: () => Promise<void>
}> {
    const server = createPaidMcpServer({
        name: 'test-server',
        version: '0.0.0',
        recipient: TEST_AGENT_ADDRESS,
        secretKey: DEMO_SECRET,
        network: 'testnet',
        tools: opts.tools,
        ...opts.serverConfig,
    })

    const client = createPaidMcpClient({
        name: 'test-client',
        version: '0.0.0',
        privateKey: TEST_AGENT_KEY,
        maxPerCall: '1.00',
        maxTotal: '10.00',
        network: 'testnet',
        ...opts.clientConfig,
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.server.connect(serverTransport)
    await client.connect(clientTransport)

    // We expose the raw MCP client as well for tests that want to inspect
    // raw JSON-RPC responses (not strictly needed yet, but handy).
    const rawClient = (client as unknown as { baseClient: Client }).baseClient

    return {
        server,
        client,
        rawClient,
        dispose: async () => {
            await client.close().catch(() => { })
        },
    }
}

/** A helper to wait up to N milliseconds for a predicate. */
export async function waitFor(
    predicate: () => boolean,
    timeoutMs = 5_000,
    intervalMs = 50
): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return
        await new Promise((r) => setTimeout(r, intervalMs))
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}
