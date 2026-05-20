# Paid Subscription MCP — Access Keys

Demonstrates the third pricing primitive on this gateway: **access-key pricing**, the subscription model.

## How it differs from per-call and session

| | per-call / tiered | session | access-key |
|---|---|---|---|
| First-call cost | per-call price | upfront deposit | upfront price |
| Subsequent-call cost | per-call price | per-call voucher (off-chain) | free until key expires |
| On-chain txs for N calls | N | 2 (open + close) | 1 (mint) |
| Best floor | ~$0.001 | ~$0.0001 | flat upfront fee |
| Authorization scope | each call independently | one channel | one key |
| Best for | discrete API hits | streaming/high-frequency | "buy a day pass / 1000 calls" |

Sessions and access-keys both amortize many calls across one payment. Sessions track cumulative spend off-chain; access-keys lock in a fixed call/time bound at issue time.

## Run it

```bash
# Terminal 1
npm run example:subscription:server

# Terminal 2
npm run example:subscription:client
```

The client demonstrates:

1. Pay $0.005 → receive a key good for 5 calls or 1 day
2. Make 4 follow-up calls — all free, key counter decrements each time
3. Drain the key on the 5th call
4. 6th call pays again to mint a fresh key

Total spend for 6 calls: **$0.010**. With per-call pricing at the same `$0.005` rate it would have been **$0.030**.

## What the agent sees

```
🤖 AI Agent — Access-Key Pricing Demo
✓ Connected to paid-subscription MCP server

💸 Calling "day_pass_quote" (pays $0.005, mints a key)...
   → "The market is mood, not math."
   paid: true
   tx:   0xabc123...
   key:  mppmcp_a8f3...  remaining=4, expires=2026-05-16T...

🎟️  call #2: "Time in beats timing." (paid=false, remaining=3)
🎟️  call #3: "Bonds eat dollars..."   (paid=false, remaining=2)
🎟️  call #4: "A consensus trade..."   (paid=false, remaining=1)

🔁 5th call (should drain the key)...
   → "Every chart is a Rorschach..."  paid=false, remaining=0

🔁 6th call (key was drained — pays again)...
   → "The market is mood, not math."
   paid: true
   tx:   0xdef456...
   new key: mppmcp_91e2...  remaining=4

💼 Cached keys at end of session:
   • day_pass_quote: mppmcp_91e2...  remaining=4

Total on-chain spend: $0.010000
  (would have been $0.030 with per-call pricing for 6 calls)
```

## Pricing config shapes

```ts
// Bounded by both time AND calls — whichever runs out first wins.
{
    type: 'access-key',
    amount: '0.005',
    validFor: '1d',     // '60s', '15m', '4h', '7d', '30d'
    maxCalls: 5,
}

// Time-only (unlimited calls within window).
{
    type: 'access-key',
    amount: '0.01',
    validFor: '5m',
}

// Call-only (no expiry — a "100-call pack").
{
    type: 'access-key',
    amount: '0.05',
    maxCalls: 100,
}
```

At least one of `validFor` or `maxCalls` is required — pricing without bounds is a footgun (one payment, unlimited free access forever) and the gateway rejects it at construction time.

## Server-side notes

- Access-key state is held in the same `Store.Store` mppx uses for sessions. The default is in-memory; pass your own via `accessKeyStore` for multi-process or Redis-backed deployments.
- Keys are scoped per-tool. Paying for `day_pass_quote` does not authorize calls to `call_pack`.
- Keys are 32-byte cryptographically random tokens prefixed `mppmcp_` — formatted long enough to survive accidental log truncation.
- The server ships an `accessKeysIssued` and `accessKeysExpired` counter in `getStats()` for revenue tracking.

## Client-side notes

- The cache is keyed by tool name, in-memory. Persist `client.getAccessKeys()` to disk if you want keys to survive a process restart.
- The cache evicts entries that are obviously expired or exhausted at lookup time, so a long-running client doesn't ship dead keys to the server.
- `client.clearAccessKey(toolName)` and `client.clearAccessKeys()` let you force a re-pay.
