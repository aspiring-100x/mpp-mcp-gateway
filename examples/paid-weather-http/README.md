# Paid Weather MCP — Streamable HTTP

The MCP **Streamable HTTP** transport (introduced in `@modelcontextprotocol/sdk` 1.x) is the modern way to expose an MCP server over the network. A single endpoint (`/mcp`) handles both directions:

- **`POST /mcp`** — client → server JSON-RPC messages
- **`GET /mcp`** — server → client SSE stream

A session is established on the first request and the client echoes the `Mcp-Session-Id` header on every subsequent request, so the server can route messages to the right transport instance.

This example shows the same paid weather server as `paid-weather-mcp/` but exposed over Streamable HTTP instead of stdio.

## Prerequisites

1. Fund the agent wallet on Tempo testnet (one-time, only needed for paid tools):

   ```bash
   cast rpc tempo_fundAddress 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
     --rpc-url https://rpc.moderato.tempo.xyz
   ```

2. Optional environment variables:

   ```bash
   set PORT=3010
   set RECIPIENT_ADDRESS=0xYourWallet
   set PAYMENT_SECRET_KEY=any-32-char-random-string
   set AGENT_PRIVATE_KEY=0x...
   ```

## Run it

Two terminals, two commands:

```bash
# Terminal 1 — start the server
npm run example:http:server

# Terminal 2 — run the agent
npm run example:http:client
```

You should see the agent list tools, ping (free), then call `get_weather` and `get_forecast` — each paid call prints the on-chain transaction hash from Tempo.

## Test with curl

The server speaks plain JSON-RPC, so any HTTP client works. List tools without a session:

```bash
curl -X POST http://localhost:3010/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  -i
```

The response includes a `Mcp-Session-Id` header. Pass that on subsequent requests:

```bash
curl -X POST http://localhost:3010/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Session-Id: <id-from-init>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Calling a paid tool over raw curl will return MCP error code `-32042` with an MPP challenge in `error.data.challenges`. The challenge → sign → retry flow only happens automatically when you use `createPaidMcpClient` (the example client).

## Notes

- The example uses `createMcpExpressApp({ host: '127.0.0.1' })` which auto-enables DNS-rebinding protection for localhost. For 0.0.0.0 deployments, pass `allowedHosts`.
- Sessions live in process memory (`Map<sessionId, transport>`). For multi-instance deployments you'd want sticky sessions or an external session store.
- Paid-tool gas / settlement is identical to stdio — only the wire format changed.
