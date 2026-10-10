import assert from 'node:assert/strict'
import test from 'node:test'
import { incident, raw } from './fixtures/incident.ts'
import { overlaps, parseEndpoint, parseLsof, parseNetstat, parsePs } from './scan.ts'
import type { Socket } from './types.ts'

const appOn = (port: number, pid?: number) => {
  const app = incident().snapshot.apps.find(a => a.sockets.some(s => s.port === port) && (pid === undefined || a.pid === pid))
  assert.ok(app, `an app listens on ${port}`)
  return app
}

test('endpoints: wildcard, IPv4, bracketed IPv6', () => {
  assert.deepEqual(parseEndpoint('*:8790'), { address: '*', port: 8790 })
  assert.deepEqual(parseEndpoint('100.101.102.103:8790'), { address: '100.101.102.103', port: 8790 })
  assert.deepEqual(parseEndpoint('[::1]:4567'), { address: '::1', port: 4567 })
  assert.equal(parseEndpoint('garbage'), null)
})

test('lsof keeps every address a process listens on', () => {
  const workerd = parseLsof(raw.lsof).find(p => p.pid === 70631)
  assert.deepEqual(
    workerd?.sockets.map(s => `${s.address}:${s.port}`),
    ['100.101.102.103:8790', '100.101.102.103:64508', '127.0.0.1:9229', '127.0.0.1:64509'],
  )
  assert.equal(workerd?.pgid, 70438)
})

test('netstat marks dual-stack wildcards and finds root listeners lsof cannot see', () => {
  const rows = parseNetstat(raw.netstat)
  assert.ok(rows.find(r => r.pid === 2957 && r.port === 8790)?.dualStack)
  assert.equal(rows.find(r => r.pid === 38559 && r.family === 'IPv6')?.dualStack, false)
  assert.ok(rows.some(r => r.pid === 1 && r.port === 22))
  assert.ok(!rows.some(r => r.port === 60629), 'established connections are not listeners')
})

test('ps start time is local time and commands keep their spaces', () => {
  const procs = parsePs(raw.ps)
  assert.equal(procs.get(2957)?.startEpoch, new Date(2026, 9, 8, 0, 15, 59).getTime() / 1000)
  assert.equal(procs.get(9300)?.command.startsWith('/Applications/Google Chrome.app/'), true)
  assert.equal(procs.get(2660)?.tty, 'ttys003')
})

test('the 8790 incident: a Tailscale-IP bind silently takes traffic from the wildcard hub', () => {
  const { snapshot } = incident()
  const hub = appOn(8790, 2957)
  const talk = appOn(8790, 70631)
  assert.equal(hub.name, 'home-hub')
  assert.equal(hub.reservation, 'home-hub')
  assert.equal(hub.kind, 'service')
  assert.equal(hub.scope, 'all')
  assert.equal(hub.sockets[0]?.dualStack, true)
  assert.equal(hub.url, 'http://my-macbook-pro:8790')
  assert.equal(talk.name, 'conf-talk', 'named after its project directory')
  assert.equal(talk.reservation, undefined, 'it does not own the reservation')
  assert.equal(talk.scope, 'tailnet')
  const conflict = snapshot.conflicts.find(c => c.port === 8790)
  assert.ok(conflict)
  assert.deepEqual(new Set(conflict.apps), new Set([hub.id, talk.id]))
  assert.match(conflict.explanation, /conf-talk \(pid 70631\) answers 100\.101\.102\.103; home-hub \(pid 2957\) answers every other address/)
  assert.match(conflict.explanation, /holds port 8790, which is reserved for "home-hub"/)
})

test('two servers splitting localhost:4567 between 127.0.0.1 and [::1] is a conflict', () => {
  const conflict = incident().snapshot.conflicts.find(c => c.port === 4567)
  assert.ok(conflict)
  assert.equal(conflict.apps.length, 2)
  assert.match(conflict.explanation, /answers \[::1\].*answers 127\.0\.0\.1.*"localhost:4567" may reach either|answers 127\.0\.0\.1.*answers \[::1\]/)
})

test('one app per process group: main port first, loopback ephemeral ports collapsed', () => {
  const talk = appOn(8790, 70631)
  assert.equal(talk.port, 8790, 'the reserved, exposed port wins')
  assert.deepEqual(talk.ports, [8790, 64508, 9229], 'a Tailscale-bound ephemeral port stays visible')
  assert.equal(talk.internal, 1, '127.0.0.1:64509 is internal')
  assert.equal(talk.id, `70631-${new Date(2026, 9, 10, 13, 49, 59).getTime() / 1000}`)
})

test('kinds decide what may be stopped', () => {
  assert.equal(appOn(22).kind, 'system', 'root launchd sockets come from netstat')
  assert.equal(appOn(22).url, undefined)
  assert.equal(appOn(5000).kind, 'system')
  assert.equal(appOn(3000).kind, 'container')
  assert.equal(appOn(15721).kind, 'app', 'application.* launchd labels are GUI apps')
  assert.equal(appOn(15721).name, 'CC Switch')
  assert.equal(appOn(9222).kind, 'agent-helper')
  assert.equal(appOn(9222).name, 'chrome (debug)')
  assert.equal(appOn(57939).kind, 'agent-helper')
  assert.equal(appOn(57939).exposed, false)
})

test('reservations nobody listens on are listed as idle', () => {
  assert.deepEqual(incident().snapshot.idle.map(r => r.name), ['mlx-whisper'])
})

test('overlap rules', () => {
  const s = (address: string, family: 'IPv4' | 'IPv6', dualStack = false): Socket => ({
    address, family, dualStack, port: 1, pid: 1, scope: 'all',
  })
  assert.ok(overlaps(s('*', 'IPv4'), s('100.101.102.103', 'IPv4')))
  assert.ok(overlaps(s('*', 'IPv6', true), s('100.101.102.103', 'IPv4')), 'dual-stack wildcard covers IPv4')
  assert.ok(!overlaps(s('*', 'IPv6'), s('100.101.102.103', 'IPv4')), 'IPv6-only wildcard does not')
  assert.ok(!overlaps(s('127.0.0.1', 'IPv4'), s('100.101.102.103', 'IPv4')))
  assert.ok(overlaps(s('127.0.0.1', 'IPv4'), s('127.0.0.1', 'IPv4')))
})
