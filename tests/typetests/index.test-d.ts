/**
 * Type-level tests using tsd.
 *
 * These verify that the public type surface behaves as expected at
 * compile time — discriminated unions narrow correctly, config types
 * accept the right shapes, and stores are interchangeable.
 *
 * Run with: npm run test:types
 */

import { expectType, expectAssignable, expectNotAssignable } from 'tsd'

import type {
    PricingModel,
    PaidMcpServerConfig,
    PaidMcpClientConfig,
    GatewayStats,
    CallLogEntry,
    PaidCallResult,
    CurrencyOffer,
    MppMcpStore,
    RateLimiter,
    RateLimitResult,
    Logger,
    LogLevel,
    WebhookConfig,
    WebhookEventType,
    MppMcpErrorCode,
} from '../../src/index.js'

// ─── PricingModel discriminated union narrows correctly ─────────────

declare const pricing: PricingModel

if (pricing.type === 'per-call') {
    expectType<string>(pricing.amount)
    expectType<CurrencyOffer[] | undefined>(pricing.accept)
}

if (pricing.type === 'tiered') {
    expectType<Array<{ upTo: number | 'unlimited'; amount: string }>>(pricing.tiers)
}

if (pricing.type === 'session') {
    expectType<string>(pricing.amount)
    expectType<string>(pricing.unitType)
    expectType<string | undefined>(pricing.suggestedDeposit)
    expectType<CurrencyOffer[] | undefined>(pricing.accept)
}

if (pricing.type === 'access-key') {
    expectType<string>(pricing.amount)
    expectType<string | undefined>(pricing.validFor)
    expectType<number | undefined>(pricing.maxCalls)
    expectType<CurrencyOffer[] | undefined>(pricing.accept)
}

// ─── PaidCallResult generic typing ──────────────────────────────────

declare const result: PaidCallResult<{ temp: number }>
expectType<{ temp: number } | undefined>(result.data)
expectType<boolean>(result.paid)
expectType<Array<{ type: 'text'; text: string }>>(result.content)

// Unparameterized defaults to unknown
declare const resultUntyped: PaidCallResult
expectType<unknown>(resultUntyped.data)

// ─── Store interface is structurally compatible ─────────────────────

const mockStore: MppMcpStore = {
    get: async <T>(_key: string) => null as T | null,
    put: async (_key: string, _value: unknown) => { },
    delete: async (_key: string) => { },
    update: async <T>(_key: string, _transform: (c: T | null) => T | null) => null as T | null,
}
expectAssignable<MppMcpStore>(mockStore)

// Missing `update` is NOT assignable
const incompleteStore = {
    get: async <T>(_key: string) => null as T | null,
    put: async (_key: string, _value: unknown) => { },
    delete: async (_key: string) => { },
}
expectNotAssignable<MppMcpStore>(incompleteStore)

// ─── RateLimiter interface ──────────────────────────────────────────

const mockLimiter: RateLimiter = {
    consume: async (_key: string) => ({ allowed: true, remaining: 10 }) as RateLimitResult,
}
expectAssignable<RateLimiter>(mockLimiter)

// ─── Logger interface ───────────────────────────────────────────────

const mockLogger: Logger = {
    debug: (_msg: string) => { },
    info: (_msg: string) => { },
    warn: (_msg: string) => { },
    error: (_msg: string) => { },
    child: (_bindings) => mockLogger,
}
expectAssignable<Logger>(mockLogger)

// ─── Config types accept correct shapes ─────────────────────────────

const serverConfig: PaidMcpServerConfig = {
    name: 'test',
    version: '1.0.0',
    recipient: '0x1234567890123456789012345678901234567890',
    secretKey: 'secret',
    tools: [],
}
expectAssignable<PaidMcpServerConfig>(serverConfig)

const fullServerConfig: PaidMcpServerConfig = {
    name: 'test',
    version: '1.0.0',
    recipient: '0x1234567890123456789012345678901234567890',
    secretKey: 'secret',
    currency: '0x0000000000000000000000000000000000000001',
    network: 'mainnet',
    tools: [],
    callLogSize: 500,
    drainTimeoutMs: 10_000,
    logger: mockLogger,
    rateLimit: { enabled: true, refillPerMinute: 100, capacity: 50 },
    onShutdown: async () => { },
}
expectAssignable<PaidMcpServerConfig>(fullServerConfig)

const clientConfig: PaidMcpClientConfig = {
    name: 'agent',
    version: '1.0.0',
    privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
}
expectAssignable<PaidMcpClientConfig>(clientConfig)

// ─── WebhookConfig and event types ──────────────────────────────────

const webhookConfig: WebhookConfig = {
    url: 'https://example.com/hook',
    secret: 'webhook-secret',
    events: ['payment.received', 'session.closed'],
    maxAttempts: 5,
}
expectAssignable<WebhookConfig>(webhookConfig)

expectAssignable<WebhookEventType>('payment.received')
expectAssignable<WebhookEventType>('access-key.issued')
expectAssignable<WebhookEventType>('session.opened')
expectAssignable<WebhookEventType>('session.closed')
expectAssignable<WebhookEventType>('access-key.expired')
expectAssignable<WebhookEventType>('call.failed')

// ─── Error codes are a closed union ─────────────────────────────────

expectAssignable<MppMcpErrorCode>('invalid-config')
expectAssignable<MppMcpErrorCode>('rate-limited')
expectAssignable<MppMcpErrorCode>('shutting-down')
expectAssignable<MppMcpErrorCode>('store-backend-error')
expectAssignable<MppMcpErrorCode>('cas-exhausted')
expectAssignable<MppMcpErrorCode>('internal')

// ─── GatewayStats shape ─────────────────────────────────────────────

declare const stats: GatewayStats
expectType<number>(stats.totalCalls)
expectType<number>(stats.paidCalls)
expectType<string>(stats.totalRevenue)
expectType<Record<string, number>>(stats.callsByTool)
expectType<Record<string, string>>(stats.revenueByTool)
expectType<number>(stats.uptimeMs)

// ─── CallLogEntry paymentMode union ─────────────────────────────────

declare const entry: CallLogEntry
expectType<'free' | 'per-call' | 'tiered' | 'session' | 'access-key' | 'access-key-cached'>(
    entry.paymentMode
)

// ─── LogLevel is a closed union ─────────────────────────────────────

expectAssignable<LogLevel>('debug')
expectAssignable<LogLevel>('info')
expectAssignable<LogLevel>('warn')
expectAssignable<LogLevel>('error')
