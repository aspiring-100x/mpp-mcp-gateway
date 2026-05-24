/**
 * mpp-mcp-gateway
 *
 * Build MCP servers whose tools charge stablecoin micropayments via the
 * Machine Payments Protocol (MPP) on the Tempo blockchain, and build
 * AI-agent clients that pay for those tools automatically.
 *
 * @example Server (tool provider)
 * ```ts
 * import { createPaidMcpServer } from 'mpp-mcp-gateway/server'
 * import { z } from 'zod'
 *
 * const server = createPaidMcpServer({
 *   name: 'weather',
 *   version: '1.0.0',
 *   recipient: '0xYourWallet',
 *   secretKey: process.env.PAYMENT_SECRET_KEY!,
 *   tools: [
 *     {
 *       name: 'get_weather',
 *       description: 'Get weather for a city.',
 *       inputSchema: { city: z.string() },
 *       pricing: { type: 'per-call', amount: '0.001' },
 *       handler: async ({ city }) => ({
 *         content: [{ type: 'text', text: `Weather in ${city}: 72°F` }],
 *       }),
 *     },
 *   ],
 * })
 *
 * await server.startStdio()
 * ```
 *
 * @example Client (AI agent)
 * ```ts
 * import { createPaidMcpClient } from 'mpp-mcp-gateway/client'
 * import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
 *
 * const client = createPaidMcpClient({
 *   name: 'my-agent',
 *   version: '1.0.0',
 *   privateKey: process.env.AGENT_PRIVATE_KEY!,
 *   maxPerCall: '0.10',
 *   maxTotal: '10.00',
 * })
 *
 * await client.connect(new StdioClientTransport({ command: 'node', args: ['server.js'] }))
 * const result = await client.callTool('get_weather', { city: 'San Francisco' })
 * console.log(result.content[0].text, result.receipt?.reference)
 * ```
 */

export { createPaidMcpClient, PaidMcpClient, SessionDepositCapExceededError, SpendingCapExceededError } from './client.js'
export { createPaidMcpServer, PaidMcpServer } from './server.js'
export { mountDashboard, type DashboardOptions } from './dashboard.js'
export {
    buildOpenApi,
    mountDiscovery,
    type DiscoveryOptions,
    type ServiceCategory,
} from './discovery.js'
export {
    Store,
    StoreError,
    bridgeMppxStore,
    createCloudflareKvStore,
    createMemoryStore,
    createUpstashStore,
    isMppMcpStore,
    type CloudflareKvLike,
    type CloudflareKvStoreOptions,
    type LegacyThreeMethodStore,
    type MppMcpStore,
    type UpstashRedisLike,
    type UpstashStoreOptions,
} from './stores/index.js'
export * from './constants.js'
export type {
    CallLogEntry,
    GatewayStats,
    PaidCallResult,
    PaidMcpClientConfig,
    PaidMcpServerConfig,
    PaidToolDefinition,
    PricingModel,
    PricingTier,
    ToolHandlerResult,
} from './types.js'
