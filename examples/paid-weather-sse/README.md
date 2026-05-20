# Paid Weather MCP — SSE (legacy)

The **SSE transport** is the original network transport for MCP. It's been deprecated in favor of Streamable HTTP, but plenty of existing clients (older Claude Desktop builds, reference clients, third-party integrations) still speak only SSE — so it's useful to support during the migration window.

Wire shape:

| Direction | Endpoint |
|---|---|
| Server → client (SSE stream) | `GET /sse` |
| Client → server (JSON-RPC) | `POST /messages?sessionId=<id>` |

The server opens a long-lived `text/event-stream` response on `GET /sse` and uses its first event to tell the client which `messages` URL to POST to. Every subsequent client message must include the `sessionId` query param so the server can route to the right transport.

For new servers, use the Streamable HTTP example instead — single endpoint, simpler routing, fewer round-trips.

## Prerequisites

1. Fund the agent wallet on Tempo testnet (one-time, only needed for paid tools):

   ```bash
   cast rpc tempo_fundAddress 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
     --rpc-url https://rpc.moderato.tempo.xyz
   ```

2. Optional environment variables:

   ```bash
   set PORT=3011
   set RECIPIENT_ADDRESS=0xYourWallet
   set PAYMENT_SECRET_KEY=any-32-char-random-string
   set AGENT_PRIVATE_KEY=0x...
   ```

## Run it

```bash
# Terminal 1 — start the server
npm run example:sse:server

# Terminal 2 — run the agent
npm run example:sse:client
```

The agent should list tools, ping (free), then call `get_weather` (London) and `get_forecast` (New York). Each paid call prints the on-chain transaction hash from Tempo.

## Test the SSE handshake manually

Open the SSE stream:

```bash
curl -N http://localhost:3011/sse
```

You'll see the first event announce the messages endpoint and a `sessionId`:

```
event: endpoint
data: /messages?sessionId=<uuid>
```

Keep that connection open and, in another terminal, POST messages to it:

```bash
curl -X POST 'http://localhost:3011/messages?sessionId=<uuid>' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response body for the POST is empty (HTTP 202 Accepted). The actual JSON-RPC response is delivered as an event on the open SSE stream.

## Notes

- `SSEServerTransport` and `SSEClientTransport` are marked `@deprecated` in the MCP SDK — that's fine for our use case, but expect future MCP SDK majors to remove them.
- One transport per session, kept in a `Map<sessionId, transport>` and cleaned up on `onclose`.
- DNS-rebinding protection is enabled by `createMcpExpressApp({ host: '127.0.0.1' })` for localhost.
- Same paid flow, same on-chain settlement as stdio and Streamable HTTP — only the wire format differs.
