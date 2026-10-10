import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claim, load, owns, release } from './registry.ts'
import type { App, Snapshot } from './types.ts'

const empty: Snapshot = { schema: 1, scannedAt: '', host: 'h', tailnetIp: null, apps: [], conflicts: [], idle: [] }
const listening = (port: number, cwd: string, launchd?: string): App => ({
  id: `${port}-1`, pid: port, pgid: port, uid: 501, name: 'x', kind: 'dev', command: 'x', cwd,
  ...(launchd ? { launchd } : {}),
  port, ports: [port], internal: 0, scope: 'tailnet', exposed: true, startedAt: '',
  sockets: [{ address: '100.101.102.103', port, family: 'IPv4', dualStack: false, scope: 'tailnet', pid: port }],
})
const snap = (...apps: App[]) => async () => ({ ...empty, apps })

function withRegistry(fn: (path: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'portman-'))
    const agent = process.env.CLAUDECODE
    delete process.env.CLAUDECODE
    try {
      await fn(join(dir, 'registry.json'))
    } finally {
      if (agent === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = agent
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('claim picks the first pool port that is neither reserved nor live on any address', withRegistry(async path => {
  writeFileSync(path, JSON.stringify({ schema: 1, pool: [8800, 8805], reservations: { talk: { port: 8800, kind: 'preview', createdAt: '' } } }))
  const r = await claim('demo', { project: '/p' }, snap(listening(8801, '/elsewhere')), path)
  assert.equal(r.reservation.port, 8802)
  assert.equal(r.created, true)
  assert.equal(load(path).reservations.demo?.project, '/p')
}))

test('claim is idempotent and refuses to silently move a name', withRegistry(async path => {
  const first = await claim('demo', { project: '/p' }, snap(), path)
  const again = await claim('demo', { project: '/p' }, snap(), path)
  assert.equal(again.reservation.port, first.reservation.port)
  assert.equal(again.created, false)
  await assert.rejects(claim('demo', { port: 9999 }, snap(), path), /already owns port/)
}))

test('a requested port must not be reserved by another name', withRegistry(async path => {
  await claim('home-hub', { port: 8790, project: '/hub' }, snap(), path)
  await assert.rejects(claim('talk', { port: 8790, project: '/talk' }, snap(), path), /reserved for "home-hub"/)
}))

test('a requested port held by someone else is refused, by its owner accepted', withRegistry(async path => {
  const hub = listening(8790, '/hub/sub', 'com.x.hub')
  await assert.rejects(claim('talk', { port: 8790, project: '/talk' }, snap(hub), path), /in use by x \(pid 8790, \/hub\/sub\)/)
  const r = await claim('hub', { port: 8790, project: '/hub' }, snap(hub), path)
  assert.equal(r.reservation.port, 8790)
  const viaLaunchd = await claim('hub2', { port: 8790, project: '', launchd: 'com.x.hub', force: false }, snap(hub), path).catch(e => e)
  assert.match(String(viaLaunchd), /reserved for "hub"/)
}))

test('agents cannot force a busy port or release another project\'s reservation', withRegistry(async path => {
  await claim('hub', { port: 8790, project: '/hub' }, snap(), path)
  process.env.CLAUDECODE = '1'
  await assert.rejects(claim('mine', { port: 8791, force: true }, snap(), path), /--force is for people/)
  await assert.rejects(release('hub', '/talk', path), /belongs to \/hub/)
  assert.equal((await release('hub', '/hub/sub', path)).port, 8790)
}))

test('an abandoned lock older than 10 s does not block', withRegistry(async path => {
  writeFileSync(`${path}.lock`, '')
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${path}.lock`, old, old)
  await claim('demo', { project: '/p' }, snap(), path)
  assert.ok(!existsSync(`${path}.lock`))
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).reservations.demo)
}))

test('ownership: launchd label, a cwd inside the project, or nobody named', () => {
  assert.ok(owns({ launchd: 'a' }, { launchd: 'a' }))
  assert.ok(owns({ project: '/p' }, { cwd: '/p/sub' }))
  assert.ok(!owns({ project: '/p' }, { cwd: '/pp' }), 'a sibling with a shared prefix is not inside')
  assert.ok(owns({}, { cwd: '/anything' }))
})
