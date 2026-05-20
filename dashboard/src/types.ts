// Wire-format types matching the gateway's /api endpoints. Kept in sync
// manually with src/types.ts on the library side. We intentionally don't
// import from the parent package: the dashboard is meant to ship as a
// standalone static bundle, deployable independently.

export interface GatewayStats {
    totalCalls: number
    paidCalls: number
    freeCalls: number
    sessionCalls: number
    accessKeyCalls: number
    totalRevenue: string
    callsByTool: Record<string, number>
    revenueByTool: Record<string, string>
    sessionsOpened: number
    sessionsClosed: number
    accessKeysIssued: number
    accessKeysExpired: number
    uptimeMs: number
    startedAt: string
}

export interface ToolDescriptor {
    name: string
    description: string
    price: string | null
}

export type PaymentMode =
    | 'free'
    | 'per-call'
    | 'tiered'
    | 'session'
    | 'access-key'
    | 'access-key-cached'

export interface CallLogEntry {
    tool: string
    timestamp: string
    durationMs: number
    paid: boolean
    paymentMode: PaymentMode
    amount?: string
    accessKeyJustIssued?: boolean
    error?: string
}
