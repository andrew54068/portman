import { homedir } from 'node:os'
import { basename } from 'node:path'
import { serverStarts, type Start } from './command.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import { fmtAddress } from './net.ts'
import { reservedBy, within } from './registry.ts'
import { parseCwds, parseLsof, parseNetstat, parsePs } from './scan.ts'
import type { Registry } from './types.ts'

/** The part of Claude Code's PreToolUse payload the hook reads. */
export interface HookInput {
  tool_name?: string
  tool_input?: { command?: string }
  cwd?: string
}

export interface Holder {
  pid: number
  command: string
  cwd?: string
  address: string
}

export interface HookDeps {
  registry: Registry
  holders: (port: number) => Promise<Holder[]>
  projectOf: (dir: string) => string | null
}

const describe = (h: Holder) => `${basename(h.command.split(' ')[0] ?? '') || 'a process'} (pid ${h.pid}${h.cwd ? `, ${h.cwd}` : ''}) on ${h.address}`

/** The same command, rewritten to take its port from portman. */
function suggestion(start: Start, project: string | null): string {
  const home = start.dir === homedir() || start.dir === '/'
  const name = (project ? basename(project) : home ? 'preview' : basename(start.dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'preview'
  const command = start.text
    .replace(/^(nohup|exec)\s+/, '')
    .replace(new RegExp(`(^|[^\\d])${start.port}(?!\\d)`, 'g'), '$1{port}')
    .replace(/\b100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, '{ip}')
  return `portman run ${name} --bind tailnet --detach -- ${command}`
}

/** Why the command must not run, or null. Only explicit server starts are judged; everything else passes. */
export async function check(input: HookInput, deps: HookDeps): Promise<string | null> {
  if (input.tool_name !== 'Bash' || !input.tool_input?.command) return null
  const seen = new Set<number>()
  for (const start of serverStarts(input.tool_input.command, input.cwd ?? process.cwd())) {
    if (seen.has(start.port)) continue
    seen.add(start.port)
    const reason = await judge(start, deps)
    if (reason) return reason
  }
  return null
}

async function judge(start: Start, deps: HookDeps): Promise<string | null> {
  const { port } = start
  const name = reservedBy(deps.registry, port)
  const res = name ? deps.registry.reservations[name] : undefined
  const project = deps.projectOf(start.dir)
  const instead = `Do not stop it. Use a port portman hands out instead:\n  ${suggestion(start, project)}`
  if (name && res?.project && !within(start.dir, res.project)) {
    return `port ${port} is reserved for "${name}" (${res.project}); another server there would take its traffic.\n${instead}`
  }
  const holders = await deps.holders(port)
  if (!holders.length) return null
  // lavish-axi reuses a running lavish server instead of starting a second one.
  if (start.tool === 'lavish-axi' && holders.every(h => h.command.includes('lavish-axi'))) return null
  const list = holders.map(describe).join('; ')
  if (name && res?.launchd) {
    return `"${name}" runs as the launchd job ${res.launchd} on port ${port} (${list}). Don't start a second copy; restart it instead:\n  launchctl kickstart -k gui/$(id -u)/${res.launchd}`
  }
  if (name && res?.project) {
    return `"${name}" is already running on port ${port}: ${list}.\nStop the old one first: portman stop ${name}`
  }
  if (project && holders.every(h => h.cwd !== undefined && within(h.cwd, project))) {
    return `this project's own server already holds port ${port}: ${list}.\nStop it first (portman stop ${port}), or use another port.`
  }
  return `port ${port} is already in use by ${list}${name ? `, reserved for "${name}"` : ''}. On macOS a second server there can bind anyway and silently take the traffic.\n${instead}`
}

/** Who listens on one port, on any address (lsof for this user's processes, netstat for everyone else's). */
export async function liveHolders(port: number, exec: Exec = defaultExec): Promise<Holder[]> {
  const [lsofOut, netOut] = await Promise.all([
    exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pgRctn']),
    exec('netstat', ['-anv', '-p', 'tcp']),
  ])
  const procs = parseLsof(lsofOut)
  const pids = procs.map(p => p.pid)
  const [psOut, cwdOut] = pids.length
    ? await Promise.all([
        exec('ps', ['-o', 'pid=,ppid=,pgid=,uid=,stat=,tty=,lstart=,command=', '-p', pids.join(',')], { LC_ALL: 'C' }),
        exec('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]),
      ])
    : ['', '']
  const full = parsePs(psOut)
  const cwds = parseCwds(cwdOut)
  const holders: Holder[] = procs.map(p => {
    const cwd = cwds.get(p.pid)
    return {
      pid: p.pid,
      command: full.get(p.pid)?.command ?? p.command,
      ...(cwd ? { cwd } : {}),
      address: p.sockets.filter(s => s.port === port).map(s => `${fmtAddress(s.address)}:${port}`).join(', '),
    }
  })
  for (const r of parseNetstat(netOut)) {
    if (r.port !== port || r.pid <= 0 || holders.some(h => h.pid === r.pid)) continue
    holders.push({ pid: r.pid, command: 'a system process', address: `${r.address === '*' ? '*' : fmtAddress(r.address)}:${port}` })
  }
  return holders
}
