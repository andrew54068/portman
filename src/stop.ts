import { basename } from 'node:path'
import { PortmanError, within } from './registry.ts'
import type { App, Proc, Registry, Snapshot } from './types.ts'

/** How a server will be stopped. `targets` maps each pid to its start time, so a reused pid is never signalled. */
export type StopPlan =
  | { mode: 'unload'; app: App; label: string }
  | { mode: 'group'; app: App; pgid: number; targets: Map<number, number> }
  | { mode: 'tree'; app: App; targets: Map<number, number> }

export interface PlanContext {
  procs: Map<number, Proc>
  registry: Registry
  /** pid of this portman process. */
  self: number
  /** uid of the person running portman. */
  me: number
  /** Called from a Claude session (CLAUDECODE=1). */
  agent: boolean
  cwd: string
  unload: boolean
}

/** Never signalled: terminals, multiplexers, agents and the processes that host them. */
const PROTECTED_EXE = new Set([
  'claude', 'codex', 'herdr', 'tmux', 'launchd', 'login', 'sshd', 'sshd-session',
  'Terminal', 'iTerm2', 'wezterm-gui', 'ghostty', 'kitty', 'alacritty',
])

export function isProtected(p: Proc, caller: Set<number>): boolean {
  if (p.pid <= 1 || caller.has(p.pid)) return true
  if (p.command.startsWith('-')) return true // login shell, e.g. "-zsh"
  if (p.stat.includes('s') && p.tty !== '??') return true // session leader on a terminal: an interactive shell
  return PROTECTED_EXE.has(basename(p.command.split(' ')[0] ?? ''))
}

/** portman and every process above it: never signalled. */
export function callerChain(self: number, procs: Map<number, Proc>): Set<number> {
  const chain = new Set<number>([self])
  for (let p = procs.get(self); p && p.ppid > 0 && !chain.has(p.ppid); p = procs.get(p.ppid)) chain.add(p.ppid)
  return chain
}

export function descendants(root: number, procs: Map<number, Proc>): number[] {
  const children = new Map<number, number[]>()
  for (const p of procs.values()) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid])
  const out: number[] = []
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop()!
    out.push(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  return out
}

const who = (app: App) => `${app.name} (pid ${app.pid}, port ${app.port})`

/**
 * Decides what to signal, or refuses. Prefers the whole process group (it takes wrappers like `yarn` and
 * `wrangler` down with the listener); falls back to the subtree under the highest unprotected ancestor when the
 * group also holds a terminal, an agent, or portman's caller. Agent helpers only ever lose their own subtree,
 * because their parent is usually a live agent's tool server.
 */
export function planStop(app: App, ctx: PlanContext): StopPlan {
  if (app.uid !== ctx.me) throw new PortmanError(`${who(app)} belongs to another user`)
  if (app.kind === 'system') throw new PortmanError(`${who(app)} is part of macOS or Tailscale; portman won't stop it`)
  if (app.kind === 'container') {
    throw new PortmanError(`${who(app)} is a container port; stop the container in OrbStack instead`)
  }
  const caller = callerChain(ctx.self, ctx.procs)
  if (caller.has(app.pid)) throw new PortmanError(`${who(app)} is part of the process running portman`)
  const listener = ctx.procs.get(app.pid)
  if (listener && isProtected(listener, caller)) {
    throw new PortmanError(`${who(app)} is itself an agent, terminal or shell; close it where it runs`)
  }
  if (ctx.agent && app.reservation) {
    const res = ctx.registry.reservations[app.reservation]
    if (res?.project && !within(ctx.cwd, res.project)) {
      throw new PortmanError(`${who(app)} is reserved for "${app.reservation}" (${res.project}). Pick another port instead of stopping it.`)
    }
    // Shared services with no owning project (CC Switch, lavish) belong to every session: only a person stops them.
    if (res && !res.project && res.kind === 'service') {
      throw new PortmanError(`${who(app)} is the shared service "${app.reservation}"; agents may not stop it. Ask the user.`)
    }
  }
  if (app.launchd) {
    if (ctx.agent) throw new PortmanError(`${who(app)} is the launchd job ${app.launchd}; only a person may unload services. Ask the user.`)
    if (!ctx.unload) {
      throw new PortmanError(`${who(app)} is the launchd job ${app.launchd}; killing it only makes launchd restart it. Re-run with --unload to stop it until the next login.`)
    }
    return { mode: 'unload', app, label: app.launchd }
  }
  // `server & portman stop` in one shell shares a group with portman: signal the subtree, not the group.
  const sharesCallerGroup = ctx.procs.get(ctx.self)?.pgid === app.pgid
  const group = [...ctx.procs.values()].filter(p => p.pgid === app.pgid)
  if (
    app.kind !== 'agent-helper' &&
    app.pgid > 1 &&
    !sharesCallerGroup &&
    group.length &&
    !group.some(p => isProtected(p, caller))
  ) {
    return { mode: 'group', app, pgid: app.pgid, targets: new Map(group.map(p => [p.pid, p.startEpoch])) }
  }
  let root = app.pid
  if (app.kind !== 'agent-helper') {
    for (
      let parent = ctx.procs.get(ctx.procs.get(root)?.ppid ?? 0);
      parent && parent.pgid === app.pgid && !isProtected(parent, caller);
      parent = ctx.procs.get(parent.ppid)
    ) root = parent.pid
  }
  const pids = descendants(root, ctx.procs).filter(pid => {
    const p = ctx.procs.get(pid)
    return p !== undefined && !isProtected(p, caller)
  })
  return { mode: 'tree', app, targets: new Map(pids.map(pid => [pid, ctx.procs.get(pid)!.startEpoch])) }
}

export interface StopDeps {
  /** process.kill semantics: a negative pid signals a process group. */
  kill: (pid: number, signal: NodeJS.Signals) => void
  /** pid → start time for the pids still running. */
  starts: (pids: number[]) => Promise<Map<number, number>>
  /** pid → start time of whatever listens on the port now. */
  holders: (port: number) => Promise<Map<number, number>>
  launchctl: (args: string[]) => Promise<void>
  sleep: (ms: number) => Promise<void>
  uid: number
}

export interface StopResult {
  status: 'freed' | 'gone' | 'respawned' | 'still-running'
  id: string
  name: string
  port: number
  signalled: number[]
  killed: number[]
  message: string
}

function send(plan: Exclude<StopPlan, { mode: 'unload' }>, pids: number[], signal: NodeJS.Signals, deps: StopDeps) {
  const targets = plan.mode === 'group' ? [-plan.pgid] : pids
  for (const pid of targets) {
    try {
      deps.kill(pid, signal)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM') throw new PortmanError(`not permitted to signal ${pid < 0 ? `process group ${-pid}` : `pid ${pid}`}`)
      if (code !== 'ESRCH') throw err
    }
  }
}

/**
 * SIGTERM, up to `graceMs` to exit, SIGKILL for survivors, then checks who holds the port. `others` are pids of
 * other servers that already shared the port (a conflict); they are expected to stay.
 */
export async function executeStop(
  plan: StopPlan,
  deps: StopDeps,
  { graceMs = 5_000, others = new Set<number>() }: { graceMs?: number; others?: Set<number> } = {},
): Promise<StopResult> {
  const { app } = plan
  const base = { id: app.id, name: app.name, port: app.port }
  const expected = Number(app.id.split('-')[1])
  const current = (await deps.starts([app.pid])).get(app.pid)
  if (current === undefined) {
    return { ...base, status: 'gone', signalled: [], killed: [], message: `${app.name} had already exited` }
  }
  if (current !== expected) throw new PortmanError(`${app.name} already exited; pid ${app.pid} now belongs to another process`, 4)

  let signalled: number[] = []
  let killed: number[] = []
  if (plan.mode === 'unload') {
    await deps.launchctl(['bootout', `gui/${deps.uid}/${plan.label}`])
    signalled = [app.pid]
  } else {
    const alive = async () => {
      const live = await deps.starts([...plan.targets.keys()])
      return [...plan.targets].filter(([pid, start]) => live.get(pid) === start).map(([pid]) => pid)
    }
    signalled = await alive()
    send(plan, signalled, 'SIGTERM', deps)
    let left = signalled
    for (let waited = 0; left.length && waited < graceMs; waited += 200) {
      await deps.sleep(200)
      left = await alive()
    }
    if (left.length) {
      send(plan, left, 'SIGKILL', deps)
      killed = left
      await deps.sleep(300)
    }
  }

  const remaining = async () => new Map([...(await deps.holders(app.port))].filter(([pid]) => !others.has(pid)))
  let holders = await remaining()
  for (let waited = 0; holders.get(app.pid) === expected && waited < graceMs; waited += 200) {
    await deps.sleep(200)
    holders = await remaining()
  }
  if (!holders.size) {
    const message = others.size
      ? `stopped ${app.name}; port ${app.port} is now served only by pid ${[...others].join(', ')}`
      : `stopped ${app.name}; port ${app.port} is free`
    return { ...base, status: 'freed', signalled, killed, message }
  }
  if (holders.get(app.pid) === expected) {
    return { ...base, status: 'still-running', signalled, killed, message: `${app.name} is still listening on ${app.port}` }
  }
  return {
    ...base,
    status: 'respawned',
    signalled,
    killed,
    message: `port ${app.port} was taken again by pid ${[...holders.keys()].join(', ')}; something restarted it`,
  }
}

/** A target is a listener id (`<pid>-<start>`), a port, a reservation name, or a launchd label. */
export function resolveTarget(target: string, snap: Snapshot, registry: Registry): App {
  if (/^\d+-\d+$/.test(target)) {
    const app = snap.apps.find(a => a.id === target)
    if (!app) throw new PortmanError(`no server with id ${target}; it exited or its pid was reused`, 4)
    return app
  }
  const ambiguous = (apps: App[], what: string) =>
    new PortmanError(`${what} matches ${apps.length} servers; stop one by id: ${apps.map(a => `${a.id} (${a.name})`).join(', ')}`, 2)
  if (/^\d+$/.test(target)) {
    const port = Number(target)
    const apps = snap.apps.filter(a => a.sockets.some(s => s.port === port))
    if (!apps.length) throw new PortmanError(`nothing is listening on port ${port}`, 4)
    if (apps.length > 1) throw ambiguous(apps, `port ${port}`)
    return apps[0]!
  }
  const res = registry.reservations[target]
  const apps = snap.apps.filter(a => a.reservation === target || (!res && (a.name === target || a.launchd === target)))
  if (apps.length > 1) throw ambiguous(apps, `"${target}"`)
  if (apps[0]) return apps[0]
  throw new PortmanError(res ? `"${target}" (port ${res.port}) is not running` : `no server or reservation named "${target}"`, 4)
}
