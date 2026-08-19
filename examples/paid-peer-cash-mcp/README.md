# Paid Peer Cash MCP

This example charges agents in pathUSD on Tempo mainnet for selected tools from
[`peer-cash-mcp`](https://github.com/zkp2p/peer-cash-mcp), then shows the
operator-side path for cashing out the resulting revenue through Peer Cash.

The two payment lifecycles stay separate:

1. An agent pays the MCP server through MPP. Settled pathUSD lands in the
   operator's Tempo wallet.
2. The operator routes an amount of that pathUSD to Base USDC through Peer
   Cash's Relay integration.
3. Peer Cash returns unsigned Base USDC approval and `createDeposit`
   transactions. The operator reviews and signs them with its own wallet.

The MCP server never receives a wallet private key, signs a transaction, or
broadcasts a Peer Cash order.

## Run the server

This example needs Node.js 22 or newer because `peer-cash-mcp` and
`@zkp2p/cash` require it.

```bash
export RECIPIENT_ADDRESS=0xYourOperatorWallet
export PAYMENT_SECRET_KEY=replace-with-at-least-32-random-characters
npm run example:peer-cash:server
```

The stdio server exposes:

- `peer_cash_capabilities`, free discovery of live payout support
- `peer_cash_estimate`, priced at 0.001 pathUSD
- `peer_cash_prepare`, priced at 0.005 pathUSD
- `peer_cash_finalize`, priced at 0.001 pathUSD
- `peer_cash_prepare_access_policy`, priced at 0.001 pathUSD
- `peer_cash_order`, free order tracking

The companion clients in the other examples can connect to this server by
changing their spawned server path and requested tool.

## Cash out settled revenue

[`revenue.ts`](./revenue.ts) exports `cashOutRevenue()`. Call it from the
operator's application with a viem `WalletClient` connected to Tempo mainnet:

```ts
import { cashOutRevenue } from './revenue.js'

const result = await cashOutRevenue({
    amount: 10_000_000n,
    sourceSigner: operatorTempoWallet,
    receive: {
        platform: 'wise',
        currency: 'USD',
        payee: { offchainId: 'operator@example.com' },
    },
})

console.log(result.route.requestId)
console.log(result.cashout.steps)
console.log(result.cashout.txs)
```

`cashOutRevenue()` signs only the Tempo-to-Base Relay route through the wallet
the operator supplies. It then stops at Peer Cash's unsigned transaction plan.
The operator should display `cashout.steps`, obtain approval, submit the
same-index `cashout.txs`, and pass the confirmed `createDeposit` transaction
hash to the gated `peer_cash_finalize` tool. If `accessPolicyRequired` is true,
prepare and submit that follow-up before monitoring the order.

Use the live capabilities response before choosing a payout platform or
currency. Relay source support and Peer Cash payout support can change over
time.
