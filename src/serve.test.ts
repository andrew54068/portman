import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { incident } from './fixtures/incident.ts'
import { allowedHost, allowedRemote, cachedScan, createHandler } from './serve.ts'

const names = ['my-macbook-pro', 'my-macbook-pro.local', '100.101.102.103']

test('only this Mac and tailnet peers are answered', () => {
  for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.99.88.77', '::ffff:100.99.88.77', 'fd7a:115c:a1e0::1']) assert.ok(allowedRemote(ok), ok)
  for (const no of ['192.168.1.5', '10.0.0.2', '::ffff:192.168.1.5', '100.63.0.1', '100.128.0.1', undefined]) assert.ok(!allowedRemote(no), String(no))
})

test('Host must name this Mac (DNS-rebinding guard)', () => {
  for (const ok of ['my-macbook-pro:8899', '100.101.102.103:8899', 'localhost:8899', '127.0.0.1:8899', '[::1]:8899', 'my-macbook-pro.tail1234.ts.net:8899', 'my-macbook-pro.local']) {
    assert.ok(allowedHost(ok, names), ok)
  }
  for (const no of ['evil.example', 'my-macbook-pro.evil.com', 'evil.ts.net', '', undefined]) assert.ok(!allowedHost(no, names), String(no))
})

test('one scan serves every request inside the cache window, and concurrent requests share it', async () => {
  let scans = 0
  let clock = 0
  const fresh = cachedScan(async () => {
    scans++
    return incident().snapshot
  }, 3_000, () => clock)
  await Promise.all([fresh(), fresh(), fresh()])
  assert.equal(scans, 1)
  clock = 2_999
  await fresh()
  assert.equal(scans, 1)
  clock = 3_000
  await fresh()
  assert.equal(scans, 2)
})

async function withServer(fn: (port: number) => Promise<void>) {
  const handler = createHandler({ snapshot: async () => incident().snapshot, names: () => names })
  const server: Server = createServer((req, res) => void handler(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn((server.address() as { port: number }).port)
  } finally {
    server.close()
  }
}

const get = (port: number, path: string, host: string, method = 'GET') =>
  new Promise<{ status: number; type: string; body: string; csp?: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, res => {
      let body = ''
      res.on('data', chunk => (body += chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body, csp: res.headers['content-security-policy'] as string | undefined }),
      )
    })
    req.on('error', reject)
    req.end()
  })

test('the page and the snapshot are served read-only', async () => {
  await withServer(async port => {
    const page = await get(port, '/', `my-macbook-pro:${port}`)
    assert.equal(page.status, 200)
    assert.match(page.type, /text\/html/)
    assert.match(page.body, /<title>portman<\/title>/)
    assert.match(page.csp ?? '', /default-src 'none'/)
    const api = await get(port, '/api/ports', `localhost:${port}`)
    assert.equal(api.status, 200)
    assert.equal(JSON.parse(api.body).conflicts[0].port, 4567)
    assert.equal((await get(port, '/api/ports', `localhost:${port}`, 'POST')).status, 405)
    assert.equal((await get(port, '/nope', `localhost:${port}`)).status, 404)
  })
})

test('a rebinding page that names another host is refused', async () => {
  await withServer(async port => {
    assert.equal((await get(port, '/api/ports', `evil.example:${port}`)).status, 403)
  })
})
