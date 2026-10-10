import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { check, type Holder, type HookDeps } from './hook.ts'
import type { Registry } from './types.ts'

const registry: Registry = {
  schema: 1,
  pool: [8800, 8899],
  reservations: {
    'home-hub': { port: 8790, kind: 'service', project: '/hub', launchd: 'com.example.home-hub', createdAt: '' },
    'conf-talk': { port: 8800, kind: 'preview', project: '/talk', createdAt: '' },
    lavish: { port: 4391, kind: 'service', createdAt: '' },
  },
}

const deps = (holders: Record<number, Holder[]> = {}): HookDeps => ({
  registry,
  holders: async port => holders[port] ?? [],
  projectOf: dir => (dir.startsWith('/proj') ? '/proj' : dir),
})
const bash = (command: string, cwd = '/talk') => ({ tool_name: 'Bash', tool_input: { command }, cwd })
const hub: Holder = { pid: 2957, command: '/opt/homebrew/bin/node /hub/hub/src/server.ts', cwd: '/hub/hub', address: '*:8790' }

test('the incident: a talk session starting wrangler on the hub\'s port is blocked with a ready fix', async () => {
  const reason = await check(bash('(wrangler dev --ip 100.101.102.103 --port 8790 > /tmp/talk-dev.log 2>&1 &)'), deps({ 8790: [hub] }))
  assert.match(reason ?? '', /port 8790 is reserved for "home-hub" \(\/hub\)/)
  assert.match(reason ?? '', /Do not stop it/)
  assert.match(reason ?? '', /portman run talk --bind tailnet --detach -- wrangler dev --ip \{ip\} --port \{port\}/)
})

test('a busy unreserved port names its holder and says not to stop it', async () => {
  const docs: Holder = { pid: 4992, command: '/opt/homebrew/bin/python3.10 -m http.server 8807', cwd: '/docs', address: '100.101.102.103:8807' }
  const reason = await check(bash('python3 -m http.server 8807 --bind 0.0.0.0'), deps({ 8807: [docs] }))
  assert.match(reason ?? '', /already in use by python3\.10 \(pid 4992, \/docs\) on 100\.101\.102\.103:8807/)
  assert.match(reason ?? '', /silently take the traffic/)
})

test('restarting your own reserved server asks you to stop the old one', async () => {
  const old: Holder = { pid: 32789, command: 'workerd serve', cwd: '/talk', address: '100.101.102.103:8800' }
  const reason = await check(bash('yarn wrangler dev --ip 100.101.102.103 --port 8800'), deps({ 8800: [old] }))
  assert.match(reason ?? '', /"conf-talk" is already running on port 8800/)
  assert.match(reason ?? '', /portman stop conf-talk/)
})

test('your own reserved port, idle, and any free port are allowed', async () => {
  assert.equal(await check(bash('wrangler dev --ip 100.101.102.103 --port 8800'), deps()), null)
  assert.equal(await check(bash('python3 -m http.server 8850'), deps()), null)
})

test('an unreserved port held by this same project points at stopping that one', async () => {
  const mine: Holder = { pid: 1, command: 'node vite', cwd: '/proj', address: '*:5174' }
  const reason = await check(bash('vite --port 5174', '/proj/web'), deps({ 5174: [mine] }))
  assert.match(reason ?? '', /this project's own server already holds port 5174/)
})

test('lavish reuses its running server, but another holder on its port blocks it', async () => {
  const command = 'LAVISH_AXI_HOST=100.101.102.103 LAVISH_AXI_PORT=4391 npx -y lavish-axi page.html'
  const lavish: Holder = { pid: 73600, command: 'node /opt/homebrew/bin/lavish-axi server --port 4391', address: '100.101.102.103:4391' }
  assert.equal(await check(bash(command), deps({ 4391: [lavish] })), null)
  const other: Holder = { pid: 5, command: 'python3 -m http.server 4391', address: '*:4391' }
  assert.match((await check(bash(command), deps({ 4391: [other] }))) ?? '', /already in use/)
})

test('other tools and plain commands are never judged', async () => {
  assert.equal(await check({ tool_name: 'Read', tool_input: {}, cwd: '/talk' }, deps({ 8790: [hub] })), null)
  assert.equal(await check(bash('curl -s http://my-macbook-pro:8790/'), deps({ 8790: [hub] })), null)
})

test('as a CLI: exit 2 with the reason on stderr; garbage input never blocks', () => {
  const home = mkdtempSync(join(tmpdir(), 'portman-hook-'))
  try {
    writeFileSync(join(home, 'registry.json'), JSON.stringify(registry))
    const cli = join(import.meta.dirname, 'cli.ts')
    const run = (input: string) => spawnSync(process.execPath, [cli, 'hook'], { input, encoding: 'utf8', env: { ...process.env, PORTMAN_HOME: home } })
    const blocked = run(JSON.stringify(bash('wrangler dev --ip 100.101.102.103 --port 8790')))
    assert.equal(blocked.status, 2)
    assert.match(blocked.stderr, /reserved for "home-hub"/)
    assert.equal(run('{not json').status, 0)
    assert.equal(run(JSON.stringify(bash('ls -la'))).status, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a launchd service on its own port is restarted with launchctl, not duplicated or stopped', async () => {
  const reason = await check(bash('python3 -m http.server 8790', '/hub'), deps({ 8790: [hub] }))
  assert.match(reason ?? '', /runs as the launchd job com\.example\.home-hub/)
  assert.match(reason ?? '', /launchctl kickstart -k gui\/\$\(id -u\)\/com\.example\.home-hub/)
  assert.doesNotMatch(reason ?? '', /portman stop/)
})
