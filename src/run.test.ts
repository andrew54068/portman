import assert from 'node:assert/strict'
import test from 'node:test'
import { buildArgv, strayPorts } from './run.ts'

const vars = { port: 8801, ip: '100.101.102.103', url: 'http://my-macbook-pro:8801' }

test('placeholders are filled; one string with spaces runs through sh', () => {
  assert.deepEqual(buildArgv(['wrangler', 'dev', '--ip', '{ip}', '--port', '{port}'], vars), [
    'wrangler', 'dev', '--ip', '100.101.102.103', '--port', '8801',
  ])
  assert.deepEqual(buildArgv(['python3 -m http.server {port} --bind {ip}'], vars), [
    '/bin/sh', '-c', 'python3 -m http.server 8801 --bind 100.101.102.103',
  ])
})

test('a port written into the command that is not the reserved one is caught', () => {
  assert.deepEqual(strayPorts(['wrangler', 'dev', '--port', '8790'], 8801, '/tmp'), [8790])
  assert.deepEqual(strayPorts(buildArgv(['python3', '-m', 'http.server', '--bind', '{ip}'], vars), 8801, '/tmp'), [8000])
  assert.deepEqual(strayPorts(buildArgv(['wrangler', 'dev', '--ip', '{ip}', '--port', '{port}'], vars), 8801, '/tmp'), [])
})
