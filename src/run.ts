import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { serverStarts } from './command.ts'
import { exec } from './exec.ts'
import { defaultHost, tailnetIp } from './net.ts'
import { claim, load, PortmanError, type ClaimOptions } from './registry.ts'
import { scan } from './scan.ts'

export const LOG_DIR = join(homedir(), 'Library/Logs/portman')

const USAGE = 'usage: portman run <name> [--bind tailnet|loopback|all] [--detach] [--port N] -- <command using {port} and {ip}>'

/** Fills {port}, {ip} and {url}. A single argument containing spaces runs through /bin/sh. */
export function buildArgv(cmd: string[], vars: { port: number; ip: string; url: string }): string[] {
  const fill = (s: string) => s.replaceAll('{port}', String(vars.port)).replaceAll('{ip}', vars.ip).replaceAll('{url}', vars.url)
  return cmd.length === 1 && /\s/.test(cmd[0]!) ? ['/bin/sh', '-c', fill(cmd[0]!)] : cmd.map(fill)
}

const shellQuote = (w: string) => (/^[\w@%+=:,./{}-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)

/** Ports the command would listen on other than the reserved one: the server would not be where portman says. */
export function strayPorts(argv: string[], port: number, cwd: string): number[] {
  const text = argv[0] === '/bin/sh' && argv[1] === '-c' ? argv[2]! : argv.map(shellQuote).join(' ')
  return [...new Set(serverStarts(text, cwd).map(s => s.port))].filter(p => p !== port)
}

const tail = (file: string) => readFileSync(file, 'utf8').trimEnd().split('\n').slice(-15).join('\n')

export async function runCmd(args: string[]): Promise<number> {
  const split = args.indexOf('--')
  if (split < 0) throw new PortmanError(USAGE, 2)
  const { values, positionals } = parseArgs({
    args: args.slice(0, split),
    allowPositionals: true,
    options: {
      bind: { type: 'string', default: 'tailnet' },
      detach: { type: 'boolean' },
      port: { type: 'string' },
      project: { type: 'string' },
      kind: { type: 'string' },
    },
  })
  const name = positionals[0]
  const cmd = args.slice(split + 1)
  if (!name || !cmd.length) throw new PortmanError(USAGE, 2)
  const ip = { tailnet: tailnetIp(), loopback: '127.0.0.1', all: '0.0.0.0' }[values.bind]
  if (ip === undefined) throw new PortmanError('--bind is tailnet, loopback or all', 2)
  if (ip === null) throw new PortmanError('Tailscale is not up (no 100.x address on this Mac); start it, or use --bind loopback')
  const opts: ClaimOptions = {}
  if (values.port !== undefined) opts.port = Number(values.port)
  if (values.project !== undefined) opts.project = values.project
  if (values.kind === 'service' || values.kind === 'preview') opts.kind = values.kind
  const { reservation } = await claim(name, opts, async () => (await scan()).snapshot)
  const port = reservation.port

  const holders = (await scan()).snapshot.apps.filter(a => a.sockets.some(s => s.port === port))
  if (holders.length) {
    const mine = holders.find(a => a.reservation === name)
    throw new PortmanError(
      mine
        ? `${name} is already running (pid ${mine.pid}) on ${port}; stop it first: portman stop ${name}`
        : `port ${port}, reserved for ${name}, is held by ${holders.map(a => `${a.name} (pid ${a.pid})`).join(', ')}`,
    )
  }
  const url = values.bind === 'loopback' ? `http://127.0.0.1:${port}` : `http://${load().host ?? defaultHost()}:${port}`
  const argv = buildArgv(cmd, { port, ip, url })
  const stray = strayPorts(argv, port, process.cwd())
  if (stray.length) {
    throw new PortmanError(`the command would listen on ${stray.join(', ')}, but "${name}" owns ${port}; write {port} where the port goes`, 2)
  }
  if (!cmd.some(w => w.includes('{port}'))) {
    process.stderr.write(`portman: no {port} in the command; the server has to read $PORT (${port})\n`)
  }
  const env = { ...process.env, PORT: String(port), HOST: ip }

  if (!values.detach) {
    process.stderr.write(`${name} → ${url}\n`)
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', env })
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig))
    return new Promise(resolve => {
      child.on('error', err => {
        process.stderr.write(`portman: ${err.message}\n`)
        resolve(127)
      })
      child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)))
    })
  }

  // Detached: its own session and process group, so it outlives the shell (and Claude's Bash call) that started it.
  mkdirSync(LOG_DIR, { recursive: true })
  const log = join(LOG_DIR, `${name}.log`)
  const fd = openSync(log, 'a')
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ['ignore', fd, fd], env })
  closeSync(fd)
  const state: { exit: number | null; error?: string } = { exit: null }
  child.on('exit', code => (state.exit = code ?? 1))
  child.on('error', err => {
    state.exit = 127
    state.error = err.message
  })
  child.unref()
  for (let waited = 0; waited < 30_000; waited += 250) {
    await sleep(250)
    if (state.exit !== null) {
      throw new PortmanError(`${name} exited (code ${state.exit}) before listening on ${port}. ${state.error ?? `Last lines of ${log}:\n${tail(log)}`}`, 1)
    }
    if ((await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).trim()) {
      process.stderr.write(`${name} is up (pid ${child.pid}); log: ${log}\n`)
      process.stdout.write(`${url}\n`)
      return 0
    }
  }
  throw new PortmanError(`${name} is running (pid ${child.pid}) but nothing listens on ${port} after 30 s; see ${log}`, 1)
}
