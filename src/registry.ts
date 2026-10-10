import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { App, Registry, Reservation, Snapshot } from './types.ts'

export const REGISTRY_PATH = join(process.env.PORTMAN_HOME ?? join(homedir(), '.config/portman'), 'registry.json')

/** Exit codes: 2 bad usage, 3 refused, 4 not found. */
export class PortmanError extends Error {
  code: number
  constructor(message: string, code = 3) {
    super(message)
    this.code = code
  }
}

const emptyRegistry = (): Registry => ({ schema: 1, pool: [8800, 8899], reservations: {} })

export function load(path = REGISTRY_PATH): Registry {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
    throw err
  }
  const reg = JSON.parse(text) as Partial<Registry>
  return { ...emptyRegistry(), ...reg, reservations: reg.reservations ?? {} }
}

/** Writes beside the target and renames over it, so a reader never sees half a file. */
export function save(reg: Registry, path = REGISTRY_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n')
  renameSync(tmp, path)
}

/** Serializes registry edits across processes; a lock older than 10 s is treated as abandoned. */
export async function withLock<T>(fn: () => Promise<T>, path = REGISTRY_PATH): Promise<T> {
  const lock = `${path}.lock`
  mkdirSync(dirname(lock), { recursive: true })
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'))
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let stale = false
      try {
        stale = Date.now() - statSync(lock).mtimeMs > 10_000
      } catch {
        continue // released between our open and stat
      }
      if (stale) rmSync(lock, { force: true })
      else if (Date.now() > deadline) throw new PortmanError(`registry is locked (${lock}); delete it if no portman is running`)
      else await sleep(50)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

export const within = (dir: string, root: string) => dir === root || dir.startsWith(root + '/')

/** Whether a server is the reservation's owner: same launchd job, or running inside the project directory. */
export function owns(res: Pick<Reservation, 'project' | 'launchd'>, app: Pick<App, 'cwd' | 'launchd'>): boolean {
  if (res.launchd && app.launchd === res.launchd) return true
  if (res.project && app.cwd && within(app.cwd, res.project)) return true
  return !res.launchd && !res.project
}

/** Git root of a directory (so a claim from `hub/` still covers the whole repo); null outside a project. */
export function projectOf(dir: string): string | null {
  if (dir === '/' || dir === homedir()) return null
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || dir
  } catch {
    return dir
  }
}

export const reservedBy = (reg: Registry, port: number) =>
  Object.entries(reg.reservations).find(([, r]) => r.port === port)?.[0]

const describe = (a: App) => `${a.name} (pid ${a.pid}${a.cwd ? `, ${a.cwd}` : ''})`
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface ClaimOptions {
  port?: number
  /** Owner directory; defaults to the git root of the current directory. Pass '' for a reservation with no owner. */
  project?: string
  kind?: 'service' | 'preview'
  launchd?: string
  note?: string
  /** Reserve a port some other server holds right now (people only, never agents). */
  force?: boolean
}

/**
 * Reserves a port under a name. Idempotent: an existing name returns its port. A requested port must be
 * unreserved and not held by anyone but its owner, on any address; otherwise the first free pool port is used.
 */
export async function claim(
  name: string,
  opts: ClaimOptions,
  snapshot: () => Promise<Snapshot>,
  path = REGISTRY_PATH,
): Promise<{ name: string; reservation: Reservation; created: boolean }> {
  if (!NAME.test(name)) throw new PortmanError(`invalid name "${name}": use lowercase letters, digits, ".", "_", "-"`, 2)
  if (opts.force && process.env.CLAUDECODE === '1') {
    throw new PortmanError('--force is for people, not agents: pick another port instead of taking one in use')
  }
  return withLock(async () => {
    const reg = load(path)
    const existing = reg.reservations[name]
    if (existing) {
      if (opts.port !== undefined && opts.port !== existing.port) {
        throw new PortmanError(`"${name}" already owns port ${existing.port}; run "portman release ${name}" first to move it`)
      }
      return { name, reservation: existing, created: false }
    }
    const project = opts.project === undefined ? projectOf(process.cwd()) : opts.project ? resolve(opts.project) : null
    const owner = { ...(project ? { project } : {}), ...(opts.launchd ? { launchd: opts.launchd } : {}) }
    const snap = await snapshot()
    const holders = (port: number) => snap.apps.filter(a => a.sockets.some(s => s.port === port))
    let port = opts.port
    if (port !== undefined) {
      const other = reservedBy(reg, port)
      if (other) throw new PortmanError(`port ${port} is reserved for "${other}"`)
      const foreign = holders(port).filter(a => !owns(owner, a))
      if (foreign.length && !opts.force) {
        throw new PortmanError(`port ${port} is in use by ${foreign.map(describe).join(', ')}`)
      }
    } else {
      const [from, to] = reg.pool
      for (let p = from; p <= to && port === undefined; p++) if (!reservedBy(reg, p) && !holders(p).length) port = p
      if (port === undefined) throw new PortmanError(`no free port left in the pool ${from}-${to}`)
    }
    const reservation: Reservation = {
      port,
      kind: opts.kind ?? 'preview',
      ...owner,
      ...(opts.note ? { note: opts.note } : {}),
      createdAt: new Date().toISOString(),
    }
    reg.reservations[name] = reservation
    save(reg, path)
    return { name, reservation, created: true }
  }, path)
}

export async function release(name: string, cwd = process.cwd(), path = REGISTRY_PATH): Promise<Reservation> {
  return withLock(async () => {
    const reg = load(path)
    const res = reg.reservations[name]
    if (!res) throw new PortmanError(`no reservation named "${name}"`, 4)
    if (process.env.CLAUDECODE === '1' && res.project && !within(cwd, res.project)) {
      throw new PortmanError(`"${name}" belongs to ${res.project}; only that project or a person may release it`)
    }
    delete reg.reservations[name]
    save(reg, path)
    return res
  }, path)
}
