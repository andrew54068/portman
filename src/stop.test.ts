import assert from 'node:assert/strict'
import test from 'node:test'
import { incident, registry } from './fixtures/incident.ts'
import { executeStop, planStop, resolveTarget, type StopDeps } from './stop.ts'
import type { App, Proc } from './types.ts'

const base = { registry, self: 99999, me: 501, agent: false, cwd: '/Users/me', unload: false }
const appOn = (port: number, pid?: number): App => {
  const app = incident().snapshot.apps.find(a => a.sockets.some(s => s.port === port) && (pid === undefined || a.pid === pid))
  assert.ok(app)
  return app
}
const procsWith = (...extra: Proc[]) => {
  const procs = new Map(incident().parsed.procs)
  for (const p of extra) procs.set(p.pid, p)
  return procs
}
const proc = (pid: number, ppid: number, pgid: number, command: string, extra: Partial<Proc> = {}): Proc => ({
  pid, ppid, pgid, uid: 501, stat: 'S', tty: '??', startEpoch: 1000 + pid, command, ...extra,
})

test('the talk is stopped as a whole process group: wrangler wrappers go down with workerd', () => {
  const plan = planStop(appOn(8790, 70631), { ...base, procs: incident().parsed.procs })
  assert.equal(plan.mode, 'group')
  assert.ok(plan.mode === 'group' && plan.pgid === 70438)
  assert.deepEqual(plan.mode === 'group' && [...plan.targets.keys()].sort(), [70600, 70602, 70630, 70631])
})

test('a group that also holds a protected process falls back to the subtree under it', () => {
  // workerd's wrappers were launched by a claude process in the same group.
  const procs = procsWith(
    proc(70500, 1, 70438, 'claude --resume'),
    { ...incident().parsed.procs.get(70600)!, ppid: 70500 },
  )
  const plan = planStop(appOn(8790, 70631), { ...base, procs })
  assert.equal(plan.mode, 'tree')
  assert.deepEqual([...plan.targets.keys()].sort(), [70600, 70602, 70630, 70631], 'climbs to the launcher, not to claude')
})

test('portman never signals its own process group (`server & portman stop`)', () => {
  const procs = procsWith(proc(70700, 70600, 70438, '/opt/homebrew/bin/node portman stop 8790'))
  const plan = planStop(appOn(8790, 70631), { ...base, self: 70700, procs })
  assert.equal(plan.mode, 'tree')
  assert.ok(!plan.targets.has(70700))
  assert.ok(!plan.targets.has(70600), 'the caller\'s ancestors are protected too')
})

test('agent helpers lose only their own subtree', () => {
  const plan = planStop(appOn(9222), { ...base, procs: incident().parsed.procs })
  assert.equal(plan.mode, 'tree')
  assert.deepEqual([...plan.targets.keys()], [9300])
})

test('a listener that is itself an agent is refused, not signalled', () => {
  assert.throws(() => planStop(appOn(57939), { ...base, procs: incident().parsed.procs }), /itself an agent/)
})

test('launchd jobs need --unload, because killing them only triggers a restart', () => {
  const hub = appOn(8790, 2957)
  assert.throws(() => planStop(hub, { ...base, procs: incident().parsed.procs }), /launchd job com\.example\.home-hub.*--unload/)
  const plan = planStop(hub, { ...base, procs: incident().parsed.procs, unload: true })
  assert.deepEqual(plan.mode === 'unload' && plan.label, 'com.example.home-hub')
})

test('system, container and other users\' listeners are refused', () => {
  const procs = incident().parsed.procs
  assert.throws(() => planStop(appOn(5000), { ...base, procs }), /part of macOS/)
  assert.throws(() => planStop(appOn(3000), { ...base, procs }), /container port/)
  assert.throws(() => planStop(appOn(22), { ...base, procs }), /another user/)
})

test('an agent may not stop a server reserved for a different project', () => {
  const procs = incident().parsed.procs
  const dashboard = appOn(4567, 97215)
  assert.throws(() => planStop(dashboard, { ...base, procs, agent: true, cwd: '/Users/me/Documents/sharing' }), /Pick another port/)
  assert.equal(planStop(dashboard, { ...base, procs, agent: true, cwd: '/Users/me/Documents/SideProjects/dashboard/src' }).mode, 'group')
})

test('targets resolve by id, by port and by reservation; a shared port asks for an id', () => {
  const { snapshot } = incident()
  assert.throws(() => resolveTarget('8790', snapshot, registry), /matches 2 servers; stop one by id/)
  assert.equal(resolveTarget('home-hub', snapshot, registry).pid, 2957)
  const talk = appOn(8790, 70631)
  assert.equal(resolveTarget(talk.id, snapshot, registry).pid, 70631)
  assert.throws(() => resolveTarget('70631-1', snapshot, registry), /exited or its pid was reused/)
  assert.throws(() => resolveTarget('mlx-whisper', snapshot, registry), /not running/)
})

// ---------------------------------------------------------------- execution

interface World {
  alive: Map<number, number>
  listening: Map<number, number>
  signals: string[]
  /** pids that ignore SIGTERM. */
  stubborn?: Set<number>
  respawn?: [number, number]
}

function fakeDeps(w: World): StopDeps {
  const die = (pid: number) => {
    w.alive.delete(pid)
    w.listening.delete(pid)
  }
  return {
    kill: (pid, signal) => {
      w.signals.push(`${signal} ${pid}`)
      const pids = pid < 0 ? [...w.alive.keys()] : [pid]
      for (const p of pids) if (signal === 'SIGKILL' || !w.stubborn?.has(p)) die(p)
      if (w.respawn) w.listening.set(...w.respawn)
    },
    starts: async pids => new Map(pids.filter(p => w.alive.has(p)).map(p => [p, w.alive.get(p)!])),
    holders: async () => new Map(w.listening),
    launchctl: async args => {
      w.signals.push(`launchctl ${args.join(' ')}`)
      w.listening.clear()
    },
    sleep: async () => {},
    uid: 501,
  }
}

test('SIGTERM to the group frees the port', async () => {
  const talk = appOn(8790, 70631)
  const plan = planStop(talk, { ...base, procs: incident().parsed.procs })
  const start = Number(talk.id.split('-')[1])
  const procs = incident().parsed.procs
  const w: World = {
    alive: new Map([70600, 70602, 70630, 70631].map(p => [p, procs.get(p)!.startEpoch])),
    listening: new Map([[70631, start]]),
    signals: [],
  }
  const result = await executeStop(plan, fakeDeps(w))
  assert.equal(result.status, 'freed')
  assert.deepEqual(w.signals, ['SIGTERM -70438'])
})

test('survivors get SIGKILL after the grace period', async () => {
  const talk = appOn(8790, 70631)
  const procs = incident().parsed.procs
  const plan = planStop(talk, { ...base, procs })
  const w: World = {
    alive: new Map([70600, 70602, 70630, 70631].map(p => [p, procs.get(p)!.startEpoch])),
    listening: new Map([[70631, procs.get(70631)!.startEpoch]]),
    signals: [],
    stubborn: new Set([70631]),
  }
  const result = await executeStop(plan, fakeDeps(w), { graceMs: 600 })
  assert.equal(result.status, 'freed')
  assert.deepEqual(result.killed, [70631])
  assert.deepEqual(w.signals, ['SIGTERM -70438', 'SIGKILL -70438'])
})

test('a reused pid is never signalled', async () => {
  const talk = appOn(8790, 70631)
  const plan = planStop(talk, { ...base, procs: incident().parsed.procs })
  const w: World = { alive: new Map([[70631, 1]]), listening: new Map(), signals: [] }
  await assert.rejects(executeStop(plan, fakeDeps(w)), /pid 70631 now belongs to another process/)
  assert.deepEqual(w.signals, [])
})

test('stopping one of two servers sharing a port reports the other one, not a respawn', async () => {
  const talk = appOn(8790, 70631)
  const procs = incident().parsed.procs
  const plan = planStop(talk, { ...base, procs })
  const w: World = {
    alive: new Map([[70631, procs.get(70631)!.startEpoch]]),
    listening: new Map([[70631, procs.get(70631)!.startEpoch], [2957, procs.get(2957)!.startEpoch]]),
    signals: [],
  }
  const result = await executeStop(plan, fakeDeps(w), { others: new Set([2957]) })
  assert.equal(result.status, 'freed')
  assert.match(result.message, /served only by pid 2957/)
})

test('a supervisor that restarts the server is reported as a respawn', async () => {
  const talk = appOn(8790, 70631)
  const procs = incident().parsed.procs
  const plan = planStop(talk, { ...base, procs })
  const w: World = {
    alive: new Map([[70631, procs.get(70631)!.startEpoch]]),
    listening: new Map([[70631, procs.get(70631)!.startEpoch]]),
    signals: [],
    respawn: [71000, 5],
  }
  const result = await executeStop(plan, fakeDeps(w))
  assert.equal(result.status, 'respawned')
})

test('--unload boots the launchd job out instead of signalling it', async () => {
  const hub = appOn(8790, 2957)
  const procs = incident().parsed.procs
  const plan = planStop(hub, { ...base, procs, unload: true })
  const w: World = { alive: new Map([[2957, procs.get(2957)!.startEpoch]]), listening: new Map([[2957, 1]]), signals: [] }
  const result = await executeStop(plan, fakeDeps(w))
  assert.equal(result.status, 'freed')
  assert.deepEqual(w.signals, ['launchctl bootout gui/501/com.example.home-hub'])
})

test('agents may not stop a shared service that belongs to no project', () => {
  const procs = incident().parsed.procs
  const shared = { ...registry, reservations: { ...registry.reservations, 'cc-switch': { port: 15721, kind: 'service' as const, createdAt: '' } } }
  const ccSwitch = { ...appOn(15721), reservation: 'cc-switch' }
  assert.throws(() => planStop(ccSwitch, { ...base, procs, registry: shared, agent: true }), /shared service "cc-switch"; agents may not stop it/)
  assert.equal(planStop(ccSwitch, { ...base, procs, registry: shared }).mode, 'group', 'a person may')
})

test('agents may not unload launchd services', () => {
  const procs = incident().parsed.procs
  assert.throws(() => planStop(appOn(8790, 2957), { ...base, procs, agent: true, unload: true, cwd: '/Users/me/Documents/tools/home-hub' }), /only a person may unload services/)
})
