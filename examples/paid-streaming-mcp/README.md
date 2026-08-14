# Paid Streaming MCP — Session Pricing

Demonstrates the second MPP pricing primitive on this gateway: **session pricing** via on-chain payment channels.

## Why sessions?

Per-call (`charge`) pricing settles every tool call as its own Tempo transaction. Sub-second is great, but if you're running a streaming tool — say, an AI that emits 50 incremental updates per minute — that's 50 transactions, 50 confirmation waits, 50 fee payments.

**Session pricing solves that.**

1. Agent opens an escrow channel on-chain once. Locks (e.g.) $0.05.
2. Every subsequent call is an off-chain signed voucher: `cumulative = previous + $0.0001`.
3. Server validates the voucher signature and accumulated amount.
4. When the channel closes, the server submits the highest voucher on-chain. **One settlement transaction for hundreds of calls.**

Result: open + close are on-chain (~1s each); everything in between is sub-100ms.

## Run it

```bash
# Terminal 1
export SERVER_PRIVATE_KEY=0xOperatorKey
npm run example:streaming:server

# Terminal 2
npm run example:streaming:client
```

The server key is required only for session pricing. The current mppx session
method uses it to submit the highest voucher when the channel closes; use an
operator-controlled Tempo account and keep the key outside source control.

The client will:

1. List the tools (`think`, `tick`, `ping`)
2. Call `think` — this opens the channel on-chain (one-time ~1s)
3. Call `tick` three times — each is a voucher only (sub-100ms)
4. Print the cumulative voucher amount

## What the agent sees

```
🤖 AI Agent — Session Pricing Demo
✓ Connected to paid-streaming MCP server

📋 Available tools:
  • think — Simulates an "AI thought"...
  • tick  — Lightweight "next chunk" call...
  • ping  — Free liveness check.

🔓 Calling "think" (opens channel)...
   → Spent 1s thinking about "physics"...
   paid: true (~2200ms wall, includes 1s handler delay + channel open)
   tx:   0xabc123...

💸 tick #1: ...next bit of progress... (52ms — voucher only)
💸 tick #2: ...next bit of progress... (48ms — voucher only)
💸 tick #3: ...next bit of progress... (51ms — voucher only)

💼 Cumulative voucher: $0.000800 (of $0.05 channel deposit)
```

The first call wears the on-chain open cost; the rest amortize to ~50ms.

## Pricing config

```ts
pricing: {
    type: 'session',
    amount: '0.0005',         // per-unit price (USD)
    unitType: 'request',      // free-form unit label
    suggestedDeposit: '0.05', // hint to the client about channel funding
}
```

Add `minVoucherDelta: '0.0001'` to reject dust-spam vouchers below a threshold.

## Channel lifecycle in this gateway

| Stage | Who | When | On-chain? |
|---|---|---|---|
| **Open** | Client signs, server broadcasts (or client broadcasts directly) | First paid call | Yes — ~1s |
| **Voucher** | Client signs `{ channelId, cumulativeAmount }` | Every paid call after open | No |
| **Top-up** | Client signs deposit increase | When approaching deposit ceiling | Yes |
| **Close** | Recipient submits the highest voucher | Server-initiated, today | Yes — ~1s |

> **Today:** `client.close()` ends the MCP connection but does not yet drive the on-chain channel close — the recipient (server operator) settles the highest voucher when convenient. A future `client.closeSession()` API will let agents cooperatively close before disconnect.

## Picking between `per-call` and `session`

| | `per-call` / `tiered` | `session` |
|---|---|---|
| Best for | Discrete API calls that come in bursts | Streaming or high-frequency calls |
| First-call latency | ~1s | ~1s (channel open) |
| Subsequent-call latency | ~1s each | ~50ms each |
| On-chain txs per N calls | N | 2 (open + close) |
| Setup overhead | None | Channel deposit |
| Crash recovery | Each call is independent | mppx recovers via on-chain channel state |
| Best minimum amount | ~$0.001+ | ~$0.0001 |

You can mix both shapes on the same server — see `paid-weather-mcp/` for `charge`, `paid-streaming-mcp/` for `session`.
