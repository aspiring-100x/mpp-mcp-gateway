/**
 * Route settled Tempo pathUSD revenue into Base USDC, then prepare a Peer
 * Cash cash-out. The caller supplies its own viem WalletClient; no private key
 * enters the MCP server or this module.
 */

import {
    createCashClient,
    type CashoutInput,
    type RelayExecutionResult,
    type RelayQuote,
} from '@zkp2p/cash'
import type { WalletClient } from 'viem'

const TEMPO_MAINNET_CHAIN_ID = 4217
const PATH_USD = '0x20c0000000000000000000000000000000000000'

export interface CashOutRevenueInput {
    /** Settled pathUSD revenue in 6-decimal base units. */
    amount: bigint
    /** Operator wallet on Tempo and Base. */
    sourceSigner: WalletClient
    /** Peer Cash payout details. */
    receive: CashoutInput['receive']
}

export interface CashOutRevenueResult {
    quote: RelayQuote
    route: RelayExecutionResult
    /** Unsigned Base USDC approval and createDeposit transactions. */
    cashout: Awaited<ReturnType<ReturnType<typeof createCashClient>['prepare']>>
}

export async function cashOutRevenue({
    amount,
    sourceSigner,
    receive,
}: CashOutRevenueInput): Promise<CashOutRevenueResult> {
    if (!sourceSigner.account) {
        throw new Error('sourceSigner must have an account')
    }
    if (amount <= 0n) {
        throw new Error('amount must be positive')
    }

    const cash = createCashClient({ environment: 'production' })
    const operator = sourceSigner.account.address
    const sources = await cash.sourceCapabilities()
    const tempo = sources.chains.find(
        (chain) => chain.id === TEMPO_MAINNET_CHAIN_ID
    )
    const pathUsd = tempo?.tokens.find(
        (token) => token.address.toLowerCase() === PATH_USD.toLowerCase()
    )

    if (!pathUsd) {
        throw new Error(
            'Peer Cash Relay does not currently advertise Tempo mainnet pathUSD'
        )
    }

    const quote = await cash.quoteSource({
        user: operator,
        recipient: operator,
        amount,
        source: { chainId: TEMPO_MAINNET_CHAIN_ID, currency: pathUsd.address },
        tradeType: 'EXACT_INPUT',
    })
    const route = await cash.executeSourceQuote(quote, {
        signer: sourceSigner,
        recipient: operator,
    })

    // Relay's minimum output is the amount guaranteed to arrive as Base USDC.
    // The operator reviews and signs these Peer transactions separately.
    const cashout = await cash.prepare({ amount: quote.outputAmount, receive })

    return { quote, route, cashout }
}
