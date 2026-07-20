#!/usr/bin/env node
/**
 * mpp-mcp-gateway — operator CLI
 *
 * A lightweight command-line tool for inspecting and managing a
 * deployed paid MCP gateway. Consumes the gateway's existing HTTP
 * endpoints (`/api/stats`, `/api/tools`, `/api/calls`, `/openapi.json`)
 * so no new server-side code is needed.
 *
 * Usage:
 *   npx mpp-mcp inspect <url>                    # dump stats + tools + openapi
 *   npx mpp-mcp stats <url>                      # gateway stats only
 *   npx mpp-mcp tools <url>                      # list tools and prices
 *   npx mpp-mcp calls <url> [--limit=N]          # recent call log
 *   npx mpp-mcp keys list <url>                  # list live access keys
 *   npx mpp-mcp keys revoke <token> <url>        # revoke an access key
 *
 * Authentication:
 *   --token=<bearer>    Bearer token for protected endpoints
 *   --header=<k:v>      Custom header (repeatable)
 *
 * @module
 */

// ─── Argument parsing ───────────────────────────────────────────────

interface ParsedArgs {
    command: string
    subcommand?: string
    positional: string[]
    flags: Record<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
    const args = argv.slice(2) // skip node + script
    const positional: string[] = []
    const flags: Record<string, string> = {}

    for (const arg of args) {
        if (arg.startsWith('--')) {
            const eq = arg.indexOf('=')
            if (eq > 0) {
                flags[arg.slice(2, eq)] = arg.slice(eq + 1)
            } else {
                flags[arg.slice(2)] = 'true'
            }
        } else {
            positional.push(arg)
        }
    }

    const command = positional[0] ?? 'help'
    const subcommand = positional.length > 1 && !positional[1]!.startsWith('http')
        ? positional[1]
        : undefined

    return { command, subcommand, positional, flags }
}

// ─── HTTP helpers ───────────────────────────────────────────────────

function buildHeaders(flags: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {}
    if (flags.token) {
        headers['Authorization'] = `Bearer ${flags.token}`
    }
    if (flags.header) {
        const sep = flags.header.indexOf(':')
        if (sep > 0) {
            headers[flags.header.slice(0, sep).trim()] = flags.header.slice(sep + 1).trim()
        }
    }
    return headers
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
    const res = await fetch(url, { headers })
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`)
    }
    return res.json() as Promise<T>
}

async function deleteJson<T>(url: string, headers: Record<string, string>): Promise<{ status: number; body: T }> {
    const res = await fetch(url, { method: 'DELETE', headers })
    const body = (await res.json().catch(() => ({}))) as T
    return { status: res.status, body }
}

function resolveUrl(positional: string[], subcommand?: string): string {
    // Find the first positional that looks like a URL
    for (const p of positional.slice(subcommand ? 2 : 1)) {
        if (p.startsWith('http://') || p.startsWith('https://')) return p.replace(/\/$/, '')
    }
    throw new Error('Missing URL argument. Usage: npx mpp-mcp <command> <url>')
}

/**
 * Extract the first non-URL positional after a subcommand — used for
 * `keys revoke <token> <url>` to pull the token out regardless of
 * argument order.
 */
function resolveToken(positional: string[]): string | undefined {
    for (const p of positional.slice(2)) {
        if (!p.startsWith('http://') && !p.startsWith('https://')) return p
    }
    return undefined
}

// ─── Formatters ─────────────────────────────────────────────────────

function formatStats(stats: Record<string, unknown>): string {
    const lines: string[] = ['', '  Gateway Stats', '  ─────────────']
    const entries: Array<[string, unknown]> = [
        ['Total calls', stats.totalCalls],
        ['Paid calls', stats.paidCalls],
        ['Free calls', stats.freeCalls],
        ['Session calls', stats.sessionCalls],
        ['Access-key calls', stats.accessKeyCalls],
        ['Total revenue', `$${stats.totalRevenue}`],
        ['Sessions opened', stats.sessionsOpened],
        ['Sessions closed', stats.sessionsClosed],
        ['Keys issued', stats.accessKeysIssued],
        ['Keys expired', stats.accessKeysExpired],
        ['Uptime', formatDuration(stats.uptimeMs as number)],
        ['Started at', stats.startedAt],
    ]
    for (const [label, value] of entries) {
        lines.push(`  ${label.padEnd(18)} ${value}`)
    }
    if (stats.revenueByTool && Object.keys(stats.revenueByTool as object).length > 0) {
        lines.push('', '  Revenue by Tool')
        for (const [tool, amount] of Object.entries(stats.revenueByTool as Record<string, string>)) {
            lines.push(`    ${tool.padEnd(24)} $${amount}`)
        }
    }
    return lines.join('\n')
}

function formatTools(tools: Array<{ name: string; description: string; price: string | null }>): string {
    const lines: string[] = ['', '  Tools', '  ─────']
    if (tools.length === 0) {
        lines.push('  (no tools registered)')
        return lines.join('\n')
    }
    const maxName = Math.max(...tools.map((t) => t.name.length), 4)
    lines.push(`  ${'Name'.padEnd(maxName + 2)}${'Price'.padEnd(12)}Description`)
    lines.push(`  ${'─'.repeat(maxName + 2)}${'─'.repeat(12)}${'─'.repeat(30)}`)
    for (const t of tools) {
        const price = t.price ? `$${t.price}` : 'free'
        lines.push(`  ${t.name.padEnd(maxName + 2)}${price.padEnd(12)}${t.description}`)
    }
    return lines.join('\n')
}

function formatCalls(calls: Array<Record<string, unknown>>): string {
    const lines: string[] = ['', '  Recent Calls', '  ────────────']
    if (calls.length === 0) {
        lines.push('  (no calls recorded)')
        return lines.join('\n')
    }
    for (const call of calls.slice(0, 50)) {
        const ts = (call.timestamp as string).slice(11, 19)
        const tool = (call.tool as string).padEnd(20)
        const mode = (call.paymentMode as string).padEnd(16)
        const dur = `${call.durationMs}ms`.padEnd(8)
        const amount = call.amount ? `$${call.amount}` : ''
        const err = call.error ? ` ✗ ${call.error}` : ''
        lines.push(`  ${ts}  ${tool}${mode}${dur}${amount}${err}`)
    }
    if (calls.length > 50) {
        lines.push(`  ... and ${calls.length - 50} more`)
    }
    return lines.join('\n')
}

function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const h = Math.floor(m / 60)
    const d = Math.floor(h / 24)
    if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
    if (m > 0) return `${m}m ${s % 60}s`
    return `${s}s`
}

// ─── Commands ───────────────────────────────────────────────────────

async function cmdInspect(url: string, headers: Record<string, string>): Promise<void> {
    // Fetch all three endpoints in parallel
    const [statsRes, toolsRes, callsRes] = await Promise.allSettled([
        fetchJson<{ stats: Record<string, unknown> }>(`${url}/api/stats`, headers),
        fetchJson<{ tools: Array<{ name: string; description: string; price: string | null }> }>(
            `${url}/api/tools`,
            headers
        ),
        fetchJson<{ calls: Array<Record<string, unknown>> }>(`${url}/api/calls?limit=20`, headers),
    ])

    console.log(`\n  Inspecting: ${url}`)
    console.log(`  ${'═'.repeat(50)}`)

    if (statsRes.status === 'fulfilled') {
        console.log(formatStats(statsRes.value.stats))
    } else {
        console.log(`\n  Stats: ✗ ${statsRes.reason}`)
    }

    if (toolsRes.status === 'fulfilled') {
        console.log(formatTools(toolsRes.value.tools))
    } else {
        console.log(`\n  Tools: ✗ ${toolsRes.reason}`)
    }

    if (callsRes.status === 'fulfilled') {
        console.log(formatCalls(callsRes.value.calls))
    } else {
        console.log(`\n  Calls: ✗ ${callsRes.reason}`)
    }

    console.log('')
}

async function cmdStats(url: string, headers: Record<string, string>): Promise<void> {
    const { stats } = await fetchJson<{ stats: Record<string, unknown> }>(`${url}/api/stats`, headers)
    console.log(formatStats(stats))
    console.log('')
}

async function cmdTools(url: string, headers: Record<string, string>): Promise<void> {
    const { tools } = await fetchJson<{
        tools: Array<{ name: string; description: string; price: string | null }>
    }>(`${url}/api/tools`, headers)
    console.log(formatTools(tools))
    console.log('')
}

async function cmdCalls(url: string, headers: Record<string, string>, limit: number): Promise<void> {
    const { calls } = await fetchJson<{ calls: Array<Record<string, unknown>> }>(
        `${url}/api/calls?limit=${limit}`,
        headers
    )
    console.log(formatCalls(calls))
    console.log('')
}

async function cmdKeysList(url: string, headers: Record<string, string>): Promise<void> {
    // Prefer the dedicated /api/keys endpoint. Fall back to deriving
    // issuances from the call log if the gateway predates that endpoint.
    let keys: Array<Record<string, unknown>> | undefined
    try {
        const res = await fetchJson<{ keys: Array<Record<string, unknown>> }>(
            `${url}/api/keys`,
            headers
        )
        keys = res.keys
    } catch {
        keys = undefined
    }

    if (keys) {
        const lines: string[] = ['', '  Access Keys', '  ───────────']
        if (keys.length === 0) {
            lines.push('  (no live access keys)')
        } else {
            for (const k of keys) {
                const tool = String(k.tool ?? '').padEnd(20)
                const remaining =
                    k.remainingCalls !== undefined ? `${k.remainingCalls} calls` : 'unlimited'
                const expires = k.expiresAt ? ` exp ${String(k.expiresAt).slice(0, 19)}` : ''
                lines.push(`  ${String(k.key)}`)
                lines.push(`    ${tool} ${remaining}${expires}`)
            }
        }
        console.log(lines.join('\n'))
        console.log('')
        return
    }

    // Legacy fallback: access keys are embedded in call log entries when
    // `accessKeyJustIssued` is true.
    const { calls } = await fetchJson<{ calls: Array<Record<string, unknown>> }>(
        `${url}/api/calls?limit=1000`,
        headers
    )
    const keyIssues = calls.filter((c) => c.accessKeyJustIssued === true)
    const lines: string[] = ['', '  Access Keys (issued via call log)', '  ──────────────────────────────────']
    if (keyIssues.length === 0) {
        lines.push('  (no key issuances found in recent call log)')
    } else {
        for (const entry of keyIssues) {
            const ts = (entry.timestamp as string).slice(0, 19)
            const tool = entry.tool as string
            const amount = entry.amount ? `$${entry.amount}` : ''
            lines.push(`  ${ts}  ${tool.padEnd(20)} ${amount}`)
        }
    }
    console.log(lines.join('\n'))
    console.log('')
}

async function cmdKeysRevoke(
    token: string,
    url: string,
    headers: Record<string, string>
): Promise<void> {
    const { status, body } = await deleteJson<{ revoked?: boolean; message?: string }>(
        `${url}/api/keys/${encodeURIComponent(token)}`,
        headers
    )
    if (status === 200 && body.revoked) {
        console.log(`\n  ✓ Revoked access key: ${token}\n`)
    } else if (status === 404) {
        console.log(`\n  Key not found (already revoked, expired, or never issued): ${token}\n`)
    } else if (status === 401 || status === 403) {
        console.error(`\n  ✗ Unauthorized. Supply --token=<bearer> or --header=<k:v>.\n`)
        process.exit(1)
    } else {
        console.error(`\n  ✗ Revoke failed (HTTP ${status}): ${body.message ?? 'unknown error'}\n`)
        process.exit(1)
    }
}

function printUsage(): void {
    console.log(`
  mpp-mcp-gateway CLI — inspect and manage deployed gateways

  Usage:
    npx mpp-mcp <command> [options] <url>

  Commands:
    inspect <url>              Dump stats, tools, and recent calls
    stats <url>                Show gateway statistics
    tools <url>                List registered tools and prices
    calls <url> [--limit=N]   Show recent call log (default: 100)
    keys list <url>            Show live access keys
    keys revoke <token> <url>  Revoke an access key by token

  Options:
    --token=<bearer>           Bearer token for authenticated endpoints
    --header=<key:value>       Custom request header
    --limit=<N>                Number of calls to retrieve (default: 100)
    --help                     Show this help message

  Examples:
    npx mpp-mcp inspect https://my-gateway.fly.dev --token=secret123
    npx mpp-mcp tools https://api.example.com --token=admin-token
    npx mpp-mcp calls https://api.example.com --token=tok --limit=50
`)
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const { command, subcommand, positional, flags } = parseArgs(process.argv)

    if (command === 'help' || command === '--help' || flags.help === 'true') {
        printUsage()
        return
    }

    const headers = buildHeaders(flags)

    try {
        switch (command) {
            case 'inspect': {
                const url = resolveUrl(positional)
                await cmdInspect(url, headers)
                break
            }
            case 'stats': {
                const url = resolveUrl(positional)
                await cmdStats(url, headers)
                break
            }
            case 'tools': {
                const url = resolveUrl(positional)
                await cmdTools(url, headers)
                break
            }
            case 'calls': {
                const url = resolveUrl(positional)
                const limit = Number(flags.limit ?? 100)
                await cmdCalls(url, headers, limit)
                break
            }
            case 'keys': {
                if (subcommand === 'list') {
                    const url = resolveUrl(positional, subcommand)
                    await cmdKeysList(url, headers)
                } else if (subcommand === 'revoke') {
                    const token = resolveToken(positional)
                    if (!token) {
                        console.error('  Missing token. Usage: npx mpp-mcp keys revoke <token> <url>')
                        process.exit(1)
                    }
                    const url = resolveUrl(positional, subcommand)
                    await cmdKeysRevoke(token, url, headers)
                } else {
                    console.error(`  Unknown subcommand: keys ${subcommand ?? ''}`)
                    console.error('  Available: keys list, keys revoke')
                    process.exit(1)
                }
                break
            }
            default:
                console.error(`  Unknown command: ${command}`)
                printUsage()
                process.exit(1)
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`\n  ✗ ${message}\n`)
        process.exit(1)
    }
}

main()
