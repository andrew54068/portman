import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { serverStarts } from './command.ts'

const ports = (command: string, cwd = '/tmp') => serverStarts(command, cwd).map(s => s.port)

const STARTS: Array<[string, number[]]> = [
  ['(wrangler dev --ip 100.101.102.103 --port 8790 > /tmp/talk-dev.log 2>&1 &)', [8790]],
  ['wrangler dev --ip=100.101.102.103 --port=8790', [8790]],
  ['npx wrangler dev --port 8790 --inspector-port 9230', [8790]],
  ['python3 -m http.server 8790 --bind 100.101.102.103', [8790]],
  ['nohup python3 -m http.server --bind 0.0.0.0 8807 > /dev/null 2>&1 &', [8807]],
  ['cd /tmp/x && exec python3 -m http.server 8092 --bind 0.0.0.0', [8092]],
  ['python3 -m http.server', [8000]],
  ['python3.12 -m http.server -d site 8081', [8081]],
  ['PORT=3000 node server.js', [3000]],
  ['env PORT=8007 node server.js', [8007]],
  ['node server.js --port 8790', [8790]],
  ['tsx src/server.ts --port=4568', [4568]],
  ['vite --host 0.0.0.0 --port 5174', [5174]],
  ['yarn astro dev --host 0.0.0.0 --port 4330', [4330]],
  ['pnpm exec vite --port 3001', [3001]],
  ['npx -y serve -l 3000 dist', [3000]],
  ['npx http-server -p 8080 .', [8080]],
  ['next dev -p 3005', [3005]],
  ['hugo server -p 1313', [1313]],
  ['php -S 0.0.0.0:8001 -t public', [8001]],
  ['gunicorn -b 0.0.0.0:8002 app:app', [8002]],
  ['uvicorn app:app --host 0.0.0.0 --port 8003', [8003]],
  ['python3 -m uvicorn app:app --port 8004', [8004]],
  ['streamlit run app.py --server.port 8501', [8501]],
  ['jupyter lab --port=8888 --no-browser', [8888]],
  ['mkdocs serve -a 127.0.0.1:8005', [8005]],
  ['LAVISH_AXI_HOST=100.101.102.103 LAVISH_AXI_PORT=4391 npx -y lavish-axi page.html', [4391]],
  ["bash -lc 'cd /tmp && python3 -m http.server 8790'", [8790]],
  ['timeout 30 python3 -m http.server 8006', [8006]],
  ['astro dev --port 4330 & sleep 2; curl -s localhost:4330', [4330]],
]

const SILENT = [
  'curl -s http://my-macbook-pro:8790/',
  'lsof -nP -iTCP:8790 -sTCP:LISTEN',
  'ssh -p 22 laptop uptime',
  'git commit -m "fix: wrangler dev --port 8790 collision"',
  'echo "python3 -m http.server 8790"',
  'mkdir -p /tmp/x && ls -p',
  "cat > /tmp/x.sh <<'EOF'\npython3 -m http.server 8790\nEOF\nchmod +x /tmp/x.sh",
  'kill $(lsof -t -iTCP:8790)',
  'psql --port 5432 -h localhost',
  'redis-cli -p 6380 ping',
  'vite build',
  'yarn install',
  'yarn tsc -p .',
  'rg -n -- "--port 8790" src',
  'python3 -m http.server $PORT --bind 0.0.0.0',
  'portman run talk --detach -- wrangler dev --ip {ip} --port {port}',
  'PORT=$(portman claim talk) && wrangler dev --port $PORT',
  'node -e "console.log(8790)"',
  'docker ps --format "{{.Ports}}"',
  'npm test -- --port 8790',
]

test('server starts on explicit ports are found, however they are wrapped', () => {
  for (const [command, expected] of STARTS) assert.deepEqual(ports(command), expected, command)
})

test('commands that only mention a port stay silent', () => {
  for (const command of SILENT) assert.deepEqual(ports(command), [], command)
})

test('the heredoc body is data, the command after it is not', () => {
  assert.deepEqual(ports("cat > a.txt <<EOF\nvite --port 1\nEOF\nvite --port 5175"), [5175])
})

test('cd moves the directory the server runs in', () => {
  assert.equal(serverStarts('cd ~/site && python3 -m http.server 8790', '/tmp')[0]?.dir.endsWith('/site'), true)
  assert.equal(serverStarts('cd sub && vite --port 5174', '/repo')[0]?.dir, '/repo/sub')
})

test('package scripts are read from package.json, with the outer PORT and extra args', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portman-pkg-'))
  try {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'wrangler dev --ip 100.101.102.103 --port 8790', start: 'node server.js', preview: 'vite preview' } }),
    )
    assert.deepEqual(ports('yarn dev', dir), [8790])
    assert.deepEqual(ports(`cd ${dir} && npm run dev`), [8790])
    assert.deepEqual(ports('PORT=8790 npm start', dir), [8790])
    assert.deepEqual(ports('pnpm preview --port 4180', dir), [4180])
    assert.deepEqual(ports('npm start', dir), [], 'a script without a port is not judged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
