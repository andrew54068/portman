import { execFile } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'
import { exec } from './exec.ts'
import { defaultHost } from './net.ts'
import { claim, load, PortmanError, release } from './registry.ts'
import { parsePs, scan } from './scan.ts'
import { executeStop, planStop, resolveTarget, type StopDeps } from './stop.ts'
import type { Snapshot } from './types.ts'

const HELP = `portman: owns every port on this Mac.

  portman ls [--all] [--json]       servers reachable from other machines (--all: everything); --json lists all
  portman claim <name> [--port N]   reserve a port under a name and print it (idempotent; picks one if no --port)
        [--project DIR] [--kind service|preview] [--launchd LABEL] [--note TEXT] [--force]
  portman release <name>            drop a reservation
  portman stop <name|port|id>       stop a server (launchd jobs need --unload) [--id=<id>] [--json]
  portman url <name>                address the MacBook Air uses for a reservation

Registry: ~/.config/portman/registry.json (override the folder with PORTMAN_HOME).
`

const uid = process.getuid?.() ?? 501
const print = (text: string) => process.stdout.write(text.endsWith('\n') ? text : text + '\n')

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PortmanError(`not a port: "${value}"`, 2)
  return port
}

// ---------------------------------------------------------------- ls

const ago = (iso: string, now: Date) => {
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => (r[i] ?? '').length)))
  return rows.map(r => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ').trimEnd()).join('\n')
}

export function render(snap: Snapshot, all: boolean, now = new Date()): string {
  const conflicted = new Set(snap.conflicts.flatMap(c => c.apps))
  const shown = snap.apps.filter(a => all || a.exposed || conflicted.has(a.id))
  const out: string[] = []
  if (snap.conflicts.length) {
    out.push('CONFLICTS')
    for (const c of snap.conflicts) out.push(`  ${c.port}  ${c.explanation}`)
    out.push('')
  }
  const rows = [['PORT', 'BIND', 'KIND', 'NAME', 'PID', 'UP', 'URL / COMMAND']]
  for (const a of shown) {
    const more = a.ports.length > 1 ? ` +${a.ports.slice(1).join(',')}` : ''
    rows.push([
      `${conflicted.has(a.id) ? '!' : ''}${a.port}`,
      a.scope,
      a.kind,
      a.name + more,
      String(a.pid),
      ago(a.startedAt, now),
      a.url ?? clip(a.command, 70),
    ])
  }
  out.push(table(rows))
  const hidden = snap.apps.length - shown.length
  if (hidden) out.push(`\n${hidden} more listen only on this Mac: portman ls --all`)
  if (snap.idle.length) {
    out.push('\nRESERVED, NOT RUNNING')
    out.push(table(snap.idle.map(r => [`  ${r.port}`, r.name, r.kind, r.project ?? ''])))
  }
  return out.join('\n')
}

async function ls(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { all: { type: 'boolean' }, json: { type: 'boolean' } } })
  const { snapshot } = await scan()
  print(values.json ? JSON.stringify(snapshot, null, 2) : render(snapshot, !!values.all))
  return 0
}

// ---------------------------------------------------------------- claim / release / url

async function claimCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      project: { type: 'string' },
      kind: { type: 'string' },
      launchd: { type: 'string' },
      note: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  })
  const name = positionals[0]
  if (!name) throw new PortmanError('usage: portman claim <name> [--port N]', 2)
  const kind = values.kind
  if (kind !== undefined && kind !== 'service' && kind !== 'preview') throw new PortmanError('--kind is service or preview', 2)
  const result = await claim(
    name,
    {
      ...(values.port !== undefined ? { port: parsePort(values.port) } : {}),
      ...(values.project !== undefined ? { project: values.project } : {}),
      ...(kind ? { kind } : {}),
      ...(values.launchd ? { launchd: values.launchd } : {}),
      ...(values.note ? { note: values.note } : {}),
      ...(values.force ? { force: true } : {}),
    },
    async () => (await scan()).snapshot,
  )
  if (values.json) print(JSON.stringify({ ok: true, ...result }))
  else {
    // stdout carries only the port, so `--port $(portman claim name)` works; the note goes to stderr.
    if (result.created) process.stderr.write(`reserved ${name} → ${result.reservation.port}\n`)
    print(String(result.reservation.port))
  }
  return 0
}

async function releaseCmd(args: string[]): Promise<number> {
  const name = args[0]
  if (!name) throw new PortmanError('usage: portman release <name>', 2)
  const res = await release(name)
  print(`released ${name} (port ${res.port})`)
  return 0
}

function urlCmd(args: string[]): number {
  const name = args[0]
  if (!name) throw new PortmanError('usage: portman url <name>', 2)
  const reg = load()
  const res = reg.reservations[name]
  if (!res) throw new PortmanError(`no reservation named "${name}"`, 4)
  print(`http://${reg.host ?? defaultHost()}:${res.port}`)
  return 0
}

// ---------------------------------------------------------------- stop

const starts = async (pids: number[]) => {
  if (!pids.length) return new Map<number, number>()
  const out = await exec('ps', ['-o', 'pid=,ppid=,pgid=,uid=,stat=,tty=,lstart=,command=', '-p', pids.join(',')], { LC_ALL: 'C' })
  return new Map([...parsePs(out)].map(([pid, p]) => [pid, p.startEpoch]))
}

const deps: StopDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  starts,
  holders: async port => {
    const out = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p'])
    return starts([...out.matchAll(/^p(\d+)$/gm)].map(m => Number(m[1])))
  },
  launchctl: async args => {
    await promisify(execFile)('launchctl', args, { timeout: 15_000 })
  },
  sleep: ms => sleep(ms),
  uid,
}

async function stopCmd(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { id: { type: 'string' }, unload: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  if (values.id !== undefined && !/^\d+-\d+$/.test(values.id)) {
    throw new PortmanError(`--id takes <pid>-<start> from "portman ls --json", got "${values.id}"`, 2)
  }
  const target = values.id ?? positionals[0]
  if (!target) throw new PortmanError('usage: portman stop <name|port|id> [--unload]', 2)
  const registry = load()
  const { snapshot, parsed } = await scan({ registry })
  const app = resolveTarget(target, snapshot, registry)
  const plan = planStop(app, {
    procs: parsed.procs,
    registry,
    self: process.pid,
    me: uid,
    agent: process.env.CLAUDECODE === '1',
    cwd: process.cwd(),
    unload: !!values.unload,
  })
  const others = new Set(
    snapshot.apps.filter(a => a.id !== app.id).flatMap(a => a.sockets.filter(s => s.port === app.port).map(s => s.pid)),
  )
  const result = await executeStop(plan, deps, { others })
  print(values.json ? JSON.stringify({ ok: true, ...result }) : result.message)
  return result.status === 'freed' || result.status === 'gone' ? 0 : 5
}

// ---------------------------------------------------------------- main

async function main(argv: string[]): Promise<number> {
  const [cmd = 'help', ...rest] = argv
  switch (cmd) {
    case 'ls':
    case 'list':
      return ls(rest)
    case 'claim':
      return claimCmd(rest)
    case 'release':
      return releaseCmd(rest)
    case 'stop':
      return stopCmd(rest)
    case 'url':
      return urlCmd(rest)
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return 0
    default:
      throw new PortmanError(`unknown command "${cmd}"\n\n${HELP}`, 2)
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  main(argv).then(
    code => {
      process.exitCode = code
    },
    (err: unknown) => {
      const code = err instanceof PortmanError ? err.code : 1
      const message = err instanceof Error ? err.message : String(err)
      if (argv.includes('--json')) print(JSON.stringify({ ok: false, code, error: message }))
      else process.stderr.write(`portman: ${message}\n`)
      process.exitCode = code
    },
  )
}
