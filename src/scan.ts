import { homedir } from 'node:os'
import { basename } from 'node:path'
import { exec as defaultExec, type Exec } from './exec.ts'
import { defaultHost, fmtAddress, isWildcard, scopeOf, tailnetIp, widest } from './net.ts'
import { load, owns } from './registry.ts'
import type { App, Conflict, Kind, Proc, Registry, Snapshot, Socket } from './types.ts'

/** Raw command output a scan is built from; tests feed captured copies. */
export interface Raw {
  lsof: string
  netstat: string
  ps: string
  launchctl: string
}

const EPHEMERAL = 49152

// ---------------------------------------------------------------- parsers

interface LsofProc {
  pid: number
  pgid: number
  ppid: number
  command: string
  sockets: Array<{ family: 'IPv4' | 'IPv6'; address: string; port: number }>
}

/** `lsof -F pgRctn`: one record per process, every address it listens on. */
export function parseLsof(out: string): LsofProc[] {
  const procs: LsofProc[] = []
  let cur: LsofProc | undefined
  let family: 'IPv4' | 'IPv6' = 'IPv4'
  for (const line of out.split('\n')) {
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'p') {
      cur = { pid: Number(val), pgid: 0, ppid: 0, command: '', sockets: [] }
      procs.push(cur)
    } else if (!cur) {
      continue
    } else if (tag === 'g') {
      cur.pgid = Number(val)
    } else if (tag === 'R') {
      cur.ppid = Number(val)
    } else if (tag === 'c') {
      cur.command = val
    } else if (tag === 't') {
      family = val === 'IPv6' ? 'IPv6' : 'IPv4'
    } else if (tag === 'n') {
      const ep = parseEndpoint(val)
      if (ep) cur.sockets.push({ family, ...ep })
    }
  }
  return procs
}

/** "*:8790", "127.0.0.1:4567", "[::1]:4567" → address and port. */
export function parseEndpoint(name: string): { address: string; port: number } | null {
  const m = name.match(/^\[(.+)\]:(\d+)$/) ?? name.match(/^([^[\]]+):(\d+)$/)
  return m ? { address: m[1]!, port: Number(m[2]) } : null
}

interface NetRow {
  family: 'IPv4' | 'IPv6'
  dualStack: boolean
  address: string
  port: number
  pid: number
}

/** `netstat -anv -p tcp` LISTEN rows: sees root/launchd listeners lsof can't, and marks tcp46 (dual-stack). */
export function parseNetstat(out: string): NetRow[] {
  const rows: NetRow[] = []
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f[5] !== 'LISTEN' || !f[0]?.startsWith('tcp')) continue
    const local = f[3] ?? ''
    const dot = local.lastIndexOf('.')
    const pid = Number(f[10])
    if (dot < 0 || !Number.isInteger(pid)) continue
    rows.push({
      family: f[0] === 'tcp4' ? 'IPv4' : 'IPv6',
      dualStack: f[0] === 'tcp46',
      address: local.slice(0, dot),
      port: Number(local.slice(dot + 1)),
      pid,
    })
  }
  return rows
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+\w{3} (\w{3})\s+(\d+) (\d\d):(\d\d):(\d\d) (\d{4})\s+(.*)$/

export const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,uid=,stat=,tty=,lstart=,command=']

/** `LC_ALL=C ps -axo pid=,ppid=,pgid=,uid=,stat=,tty=,lstart=,command=` (lstart is local time). */
export function parsePs(out: string): Map<number, Proc> {
  const procs = new Map<number, Proc>()
  for (const line of out.split('\n')) {
    const m = line.match(PS_LINE)
    if (!m) continue
    const [, pid, ppid, pgid, uid, stat, tty, mon, day, hh, mm, ss, year, command] = m
    const start = new Date(Number(year), MONTHS.indexOf(mon!), Number(day), Number(hh), Number(mm), Number(ss))
    procs.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      uid: Number(uid),
      stat: stat!,
      tty: tty!,
      startEpoch: Math.floor(start.getTime() / 1000),
      command: command!,
    })
  }
  return procs
}

/**
 * `launchctl list` → pid → label, for jobs that are running. GUI apps get `application.*` labels but aren't
 * KeepAlive jobs, so they are left out and classified as apps.
 */
export function parseLaunchctl(out: string): Map<number, string> {
  const jobs = new Map<number, string>()
  for (const line of out.split('\n')) {
    const [pid, , label] = line.split('\t')
    if (pid && /^\d+$/.test(pid) && label && !label.startsWith('application.')) jobs.set(Number(pid), label)
  }
  return jobs
}

/** `lsof -a -d cwd -Fn -p …` → pid → working directory. */
export function parseCwds(out: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid) cwds.set(pid, line.slice(1))
  }
  return cwds
}

// ---------------------------------------------------------------- classification

const exeName = (command: string) => basename(command.split(' ')[0] ?? '')

/** Agent tooling (browser bridges, coding agents, MCP servers): stopped by subtree only, never by group. */
const HELPERS: Array<[RegExp, string]> = [
  [/chrome-devtools-axi/, 'chrome-devtools-axi'],
  [/--remote-debugging-port|--headless/, 'chrome (debug)'],
  [/(^|\/)codex(\s|$)/, 'codex'],
  [/(^|\/)claude(\s|$)/, 'claude'],
  [/mcp-server|\bmcp\b|-mcp(\s|$)/i, 'mcp'],
]
export const helperName = (command: string) => HELPERS.find(([re]) => re.test(command))?.[1]

const SYSTEM_PATHS = ['/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/', '/Library/Apple/']

export function classify(command: string, uid: number, me: number, launchd: string | undefined): Kind {
  if (uid !== me) return 'system'
  if (/IPNExtension|Tailscale\.app/.test(command)) return 'system'
  if (/OrbStack|com\.docker|vpnkit|docker-proxy/.test(command)) return 'container'
  if (SYSTEM_PATHS.some(p => command.startsWith(p)) || launchd?.startsWith('com.apple.')) return 'system'
  if (helperName(command)) return 'agent-helper'
  if (launchd) return 'service'
  if (/^\/Applications\/|^\/Users\/[^/]+\/Applications\//.test(command)) return 'app'
  return 'dev'
}

/** Kinds whose working directory names the project (system daemons and helpers don't need the extra lsof). */
const CWD_KINDS = new Set<Kind>(['dev', 'service', 'app'])

// ---------------------------------------------------------------- assembly

export interface Parsed {
  procs: Map<number, Proc>
  jobs: Map<number, string>
  sockets: Socket[]
}

export function parse(raw: Raw): Parsed {
  const procs = parsePs(raw.ps)
  const jobs = parseLaunchctl(raw.launchctl)
  const net = parseNetstat(raw.netstat)
  const sockets: Socket[] = []
  const seen = new Set<string>()
  const add = (s: Omit<Socket, 'scope'>) => {
    const key = `${s.pid}|${s.family}|${s.address}|${s.port}`
    if (seen.has(key)) return
    seen.add(key)
    sockets.push({ ...s, scope: scopeOf(s.address) })
  }
  const fromLsof = new Set<string>()
  for (const p of parseLsof(raw.lsof)) {
    if (!procs.has(p.pid)) {
      // Started after ps ran: keep it, with an unknown owner so stop refuses it.
      procs.set(p.pid, { pid: p.pid, ppid: p.ppid, pgid: p.pgid, uid: -1, stat: '', tty: '??', startEpoch: 0, command: p.command })
    }
    for (const s of p.sockets) {
      fromLsof.add(`${p.pid}|${s.port}`)
      const dualStack =
        s.family === 'IPv6' && isWildcard(s.address) && net.some(n => n.pid === p.pid && n.port === s.port && n.dualStack)
      add({ pid: p.pid, family: s.family, address: s.address, port: s.port, dualStack })
    }
  }
  for (const n of net) if (n.pid > 0 && !fromLsof.has(`${n.pid}|${n.port}`)) add({ ...n })
  return { procs, jobs, sockets }
}

/**
 * The launchd job a process belongs to: its group leader, itself, or an ancestor in the same process group.
 * Ancestors outside the group don't count: a server started in a herdr pane is not part of herdr's job.
 */
export function jobOf(pid: number, parsed: Parsed): string | undefined {
  const p = parsed.procs.get(pid)
  if (!p) return parsed.jobs.get(pid)
  const direct = parsed.jobs.get(p.pgid) ?? parsed.jobs.get(pid)
  if (direct) return direct
  for (let q = parsed.procs.get(p.ppid), hops = 0; q && q.pid > 1 && q.pgid === p.pgid && hops < 32; q = parsed.procs.get(q.ppid), hops++) {
    const label = parsed.jobs.get(q.pid)
    if (label) return label
  }
  return undefined
}

/** An app before its working directory is known. */
export interface Draft extends Omit<App, 'name' | 'url' | 'reservation' | 'cwd'> {
  startEpoch: number
}

/** Groups sockets into apps by process group and picks each app's main port. */
export function assemble(parsed: Parsed, me: number, reservedPorts: Set<number>): Draft[] {
  const groups = new Map<number, Socket[]>()
  for (const s of [...parsed.sockets].sort((a, b) => a.pid - b.pid)) {
    const pgid = parsed.procs.get(s.pid)?.pgid || s.pid
    groups.set(pgid, [...(groups.get(pgid) ?? []), s])
  }
  const drafts: Draft[] = []
  for (const [pgid, all] of groups) {
    // A forked child shares its parent's listening socket; keep one copy (the lowest pid's).
    const seen = new Set<string>()
    const sockets = all.filter(s => {
      const key = `${s.family}|${s.address}|${s.port}`
      return !seen.has(key) && seen.add(key)
    })
    const exposedPort = (p: number) => sockets.some(s => s.port === p && s.scope !== 'loopback')
    const byPreference = [...new Set(sockets.map(s => s.port))].sort(
      (a, b) =>
        Number(!reservedPorts.has(a)) - Number(!reservedPorts.has(b)) ||
        Number(!exposedPort(a)) - Number(!exposedPort(b)) ||
        a - b,
    )
    const internal = (p: number) => p >= EPHEMERAL && !exposedPort(p) && !reservedPorts.has(p)
    const visible = byPreference.filter(p => !internal(p))
    const ports = visible.length ? visible : byPreference.slice(0, 1)
    const port = ports[0]!
    const main = sockets.find(s => s.port === port)!
    const proc = parsed.procs.get(main.pid)
    const launchd = jobOf(main.pid, parsed)
    const uid = proc?.uid ?? -1
    const command = proc?.command ?? ''
    const startEpoch = proc?.startEpoch ?? 0
    drafts.push({
      id: `${main.pid}-${startEpoch}`,
      pid: main.pid,
      pgid,
      uid,
      kind: classify(command, uid, me, launchd),
      command,
      ...(launchd ? { launchd } : {}),
      port,
      ports,
      internal: byPreference.length - ports.length,
      sockets,
      scope: widest(sockets.filter(s => s.port === port).map(s => s.scope)),
      exposed: sockets.some(s => s.scope !== 'loopback' && !internal(s.port)),
      startedAt: new Date(startEpoch * 1000).toISOString(),
      startEpoch,
    })
  }
  return drafts.sort((a, b) => a.port - b.port || a.pid - b.pid)
}

export const needsCwd = (d: Draft) => CWD_KINDS.has(d.kind)

// ---------------------------------------------------------------- conflicts

/** Destinations a socket accepts, per family: every address ('any'), one address, or none. */
function covers(s: Socket): { v4: string | null; v6: string | null } {
  if (isWildcard(s.address)) {
    return s.family === 'IPv4' ? { v4: 'any', v6: null } : { v4: s.dualStack ? 'any' : null, v6: 'any' }
  }
  return s.family === 'IPv4' ? { v4: s.address, v6: null } : { v4: null, v6: s.address }
}
const meet = (a: string | null, b: string | null) => a !== null && b !== null && (a === 'any' || b === 'any' || a === b)

/** Two sockets on one port where some connection could reach either: the later, narrower bind silently wins it. */
export function overlaps(a: Socket, b: Socket): boolean {
  const ca = covers(a)
  const cb = covers(b)
  return meet(ca.v4, cb.v4) || meet(ca.v6, cb.v6)
}

/** 127.0.0.1 and [::1] held by different servers: "localhost:port" reaches whichever the client tries first. */
const splitLocalhost = (a: Socket, b: Socket) => a.scope === 'loopback' && b.scope === 'loopback' && a.family !== b.family

const who = (app: Pick<App, 'name' | 'pid'>) => `${app.name} (pid ${app.pid})`

function explainPair(a: App, sa: Socket, b: App, sb: Socket): string {
  const wa = isWildcard(sa.address)
  const wb = isWildcard(sb.address)
  if (wa !== wb) {
    const [spec, sSpec, wild] = wa ? [b, sb, a] : [a, sa, b]
    return `${who(spec)} answers ${fmtAddress(sSpec.address)}; ${who(wild)} answers every other address`
  }
  if (splitLocalhost(sa, sb)) {
    return `${who(a)} answers ${fmtAddress(sa.address)} and ${who(b)} answers ${fmtAddress(sb.address)}; "localhost:${sa.port}" may reach either`
  }
  return `${who(a)} and ${who(b)} both listen on ${fmtAddress(sa.address)}`
}

export function findConflicts(apps: App[], registry: Registry): Conflict[] {
  const byPort = new Map<number, { apps: Set<string>; reasons: Set<string> }>()
  const note = (port: number, ids: string[], reason: string) => {
    const c = byPort.get(port) ?? { apps: new Set<string>(), reasons: new Set<string>() }
    for (const id of ids) c.apps.add(id)
    c.reasons.add(reason)
    byPort.set(port, c)
  }
  const entries = apps.flatMap(app => app.sockets.map(s => ({ app, s })))
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const x = entries[i]!
      const y = entries[j]!
      if (x.app.id === y.app.id || x.s.port !== y.s.port) continue
      if (overlaps(x.s, y.s) || splitLocalhost(x.s, y.s)) note(x.s.port, [x.app.id, y.app.id], explainPair(x.app, x.s, y.app, y.s))
    }
  }
  for (const [name, res] of Object.entries(registry.reservations)) {
    for (const app of apps) {
      if (!app.sockets.some(s => s.port === res.port) || owns(res, app)) continue
      note(res.port, [app.id], `${who(app)} holds port ${res.port}, which is reserved for "${name}"`)
    }
  }
  return [...byPort]
    .sort(([a], [b]) => a - b)
    .map(([port, c]) => ({ port, apps: [...c.apps], explanation: [...c.reasons].join('; ') }))
}

// ---------------------------------------------------------------- snapshot

export interface FinishContext {
  registry: Registry
  host: string
  tailnetIp: string | null
  now: Date
}

function nameOf(d: Pick<Draft, 'launchd' | 'command' | 'pid'>, cwd: string | undefined, reservation: string | undefined): string {
  if (reservation) return reservation
  if (d.launchd) return d.launchd
  const helper = helperName(d.command)
  if (helper) return helper
  const bundle = d.command.match(/([^/]+)\.app\//)?.[1]
  if (bundle) return bundle
  if (cwd && cwd !== '/' && cwd !== homedir()) return basename(cwd)
  return exeName(d.command) || `pid ${d.pid}`
}

/** Attaches working directories, reservations, names, URLs and conflicts. */
export function finish(drafts: Draft[], cwds: Map<number, string>, ctx: FinishContext): Snapshot {
  const reservations = Object.entries(ctx.registry.reservations)
  const apps: App[] = drafts.map(({ startEpoch: _start, ...d }) => {
    const cwd = cwds.get(d.pid)
    let reservation: string | undefined
    for (const port of d.ports) {
      const hit = reservations.find(([, r]) => r.port === port)
      if (hit && owns(hit[1], { cwd, launchd: d.launchd })) {
        reservation = hit[0]
        break
      }
    }
    const lan = d.sockets.find(s => s.port === d.port && s.scope === 'lan')
    const url =
      d.kind === 'system'
        ? undefined
        : d.scope === 'all' || d.scope === 'tailnet'
        ? `http://${ctx.host}:${d.port}`
        : lan
          ? `http://${fmtAddress(lan.address)}:${d.port}`
          : undefined
    return {
      ...d,
      name: nameOf(d, cwd, reservation),
      ...(cwd ? { cwd } : {}),
      ...(reservation ? { reservation } : {}),
      ...(url ? { url } : {}),
    }
  })
  const live = new Set(apps.flatMap(a => a.sockets.map(s => s.port)))
  return {
    schema: 1,
    scannedAt: ctx.now.toISOString(),
    host: ctx.host,
    tailnetIp: ctx.tailnetIp,
    apps,
    conflicts: findConflicts(apps, ctx.registry),
    idle: Object.entries(ctx.registry.reservations)
      .filter(([, r]) => !live.has(r.port))
      .map(([name, r]) => ({ name, ...r }))
      .sort((a, b) => a.port - b.port),
  }
}

/** Pure: raw command output (plus `lsof -d cwd` output) → snapshot. */
export function snapshotFrom(raw: Raw, cwdOut: string, me: number, ctx: FinishContext): { snapshot: Snapshot; parsed: Parsed } {
  const parsed = parse(raw)
  const reserved = new Set(Object.values(ctx.registry.reservations).map(r => r.port))
  return { snapshot: finish(assemble(parsed, me, reserved), parseCwds(cwdOut), ctx), parsed }
}

export interface ScanOptions {
  exec?: Exec
  registry?: Registry
  me?: number
}

/** Reads every TCP listener on this Mac (~10 ms per command, run in parallel). */
export async function scan(opts: ScanOptions = {}): Promise<{ snapshot: Snapshot; parsed: Parsed }> {
  const run = opts.exec ?? defaultExec
  const registry = opts.registry ?? load()
  const me = opts.me ?? process.getuid?.() ?? 501
  const [lsof, netstat, ps, launchctl] = await Promise.all([
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pgRctn']),
    run('netstat', ['-anv', '-p', 'tcp']),
    run('ps', PS_ARGS, { LC_ALL: 'C' }),
    run('launchctl', ['list']),
  ])
  const parsed = parse({ lsof, netstat, ps, launchctl })
  const reserved = new Set(Object.values(registry.reservations).map(r => r.port))
  const drafts = assemble(parsed, me, reserved)
  const pids = drafts.filter(needsCwd).map(d => d.pid)
  const cwdOut = pids.length ? await run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]) : ''
  const ctx = { registry, host: registry.host ?? defaultHost(), tailnetIp: tailnetIp(), now: new Date() }
  return { snapshot: finish(drafts, parseCwds(cwdOut), ctx), parsed }
}
