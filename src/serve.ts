import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { defaultHost, isLoopback, isTailnet, tailnetIp } from './net.ts'
import { claim, PortmanError, type ClaimOptions } from './registry.ts'
import { scan } from './scan.ts'
import type { Snapshot } from './types.ts'

const ROOT = resolve(import.meta.dirname, '..')
const PAGE = readFileSync(join(import.meta.dirname, 'status.html'), 'utf8')

/** This Mac and tailnet peers only: a neighbour on the LAN gets nothing even if it can reach the socket. */
export function allowedRemote(address: string | undefined): boolean {
  const a = (address ?? '').replace(/^::ffff:/, '')
  return isLoopback(a) || isTailnet(a)
}

/**
 * DNS-rebinding guard: a hostile page whose domain re-resolves to this Mac still sends its own name in Host.
 * Accept only names that really are this machine.
 */
export function allowedHost(header: string | undefined, names: string[]): boolean {
  if (!header) return false
  const host = header.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  if (isLoopback(host) || names.includes(host)) return true
  return names.some(name => host.startsWith(`${name}.`) && host.endsWith('.ts.net'))
}

const thisMac = () => {
  const short = defaultHost()
  const ip = tailnetIp()
  return [short, `${short}.local`, ...(ip ? [ip] : [])]
}

/** One scan serves every request for `maxAgeMs`; concurrent requests share the scan in flight. */
export function cachedScan(scanOnce: () => Promise<Snapshot>, maxAgeMs = 3_000, now = () => Date.now()): () => Promise<Snapshot> {
  let last: { at: number; value: Snapshot } | null = null
  let inflight: Promise<Snapshot> | null = null
  return () => {
    if (last && now() - last.at < maxAgeMs) return Promise.resolve(last.value)
    inflight ??= scanOnce()
      .then(value => {
        last = { at: now(), value }
        return value
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"

/** Read-only: the page at `/` and the snapshot at `/api/ports`. */
export function createHandler(deps: { snapshot: () => Promise<Snapshot>; names?: () => string[] }) {
  const names = deps.names ?? thisMac
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra })
      res.end(body)
    }
    if (!allowedRemote(req.socket.remoteAddress) || !allowedHost(req.headers.host, names())) {
      return send(403, 'text/plain; charset=utf-8', 'portman answers only this Mac and the tailnet\n')
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'read-only\n', { Allow: 'GET, HEAD' })
    const path = new URL(req.url ?? '/', 'http://portman').pathname
    if (path === '/') return send(200, 'text/html; charset=utf-8', PAGE, { 'Content-Security-Policy': PAGE_CSP })
    if (path === '/api/ports') {
      try {
        return send(200, 'application/json', JSON.stringify(await deps.snapshot()))
      } catch (err) {
        return send(502, 'application/json', JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    }
    return send(404, 'text/plain; charset=utf-8', 'not found\n')
  }
}

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`)

function listen(port: number, host: string, handler: ReturnType<typeof createHandler>): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => void handler(req, res))
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
}

/**
 * `portman serve`: the status page. Binds 127.0.0.1 and this Mac's Tailscale address explicitly (never `*`, so no
 * other server can quietly shadow it); while Tailscale is down it serves locally and retries the tailnet bind.
 */
export async function serveCmd(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: 'string' }, bind: { type: 'string', default: 'tailnet' } } })
  if (values.bind !== 'tailnet' && values.bind !== 'loopback') throw new PortmanError('--bind is tailnet or loopback', 2)
  const opts: ClaimOptions = { kind: 'service', project: ROOT, note: 'portman status page' }
  if (values.port !== undefined) opts.port = Number(values.port)
  const { reservation } = await claim('portman', opts, async () => (await scan()).snapshot)
  const port = reservation.port
  const handler = createHandler({ snapshot: cachedScan(async () => (await scan()).snapshot) })
  await listen(port, '127.0.0.1', handler)
  log(`portman status page on http://127.0.0.1:${port}`)
  if (values.bind === 'tailnet') {
    for (let warned = false; ; warned = true) {
      const ip = tailnetIp()
      if (ip) {
        try {
          await listen(port, ip, handler)
          log(`and for the MacBook Air on http://${defaultHost()}:${port} (${ip})`)
          break
        } catch (err) {
          log(`cannot bind ${ip}:${port}: ${err instanceof Error ? err.message : err}`)
        }
      } else if (!warned) log('Tailscale is not up; serving this Mac only and retrying every 30 s')
      await sleep(30_000)
    }
  }
  return new Promise<number>(() => {}) // serve until launchd or Ctrl-C stops the process
}
