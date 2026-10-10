import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * Reads a shell command the way the hook needs to: which servers it starts, on which explicit ports, from which
 * directory. Deliberately narrow: only known server tools count, so `curl …:8790`, `ssh -p 22` or a commit
 * message mentioning a port never block anything.
 */
export interface Start {
  port: number
  /** The server's command word ("wrangler", "http.server", …). */
  tool: string
  /** Directory the server would run in (after any `cd`). */
  dir: string
  /** The simple command, re-joined, for messages. */
  text: string
}

// ---------------------------------------------------------------- tokenizing

/** Splits a command into simple commands: no quotes, comments, redirections or heredoc bodies. */
export function segments(command: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: string | null = null
  const heredocs: string[] = []
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    const simple = stripRedirects(words)
    if (simple.length) out.push(simple)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      const next = command[++i]!
      if (next !== '\n') {
        word += next
        inWord = true
      }
    } else if (c === '#' && !inWord) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
    } else if (c === '\n') {
      endSegment()
      if (heredocs.length) {
        i = skipHeredocs(command, i + 1, heredocs) - 1
        heredocs.length = 0
      }
    } else if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      endWord()
      let j = i + 2
      if (command[j] === '-') j++
      while (command[j] === ' ' || command[j] === '\t') j++
      const q = command[j] === "'" || command[j] === '"' ? command[j++] : null
      let delim = ''
      while (j < command.length && !(q ? command[j] === q : /[\s;&|<>()]/.test(command[j]!))) delim += command[j++]
      if (q) j++
      heredocs.push(delim)
      i = j - 1
    } else if (c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
      word += c // part of a redirection: 2>&1, &>log
      inWord = true
    } else if (c === '$' && command[i + 1] === '(') {
      endSegment()
      i++
    } else if (';&|()`'.includes(c)) {
      endSegment()
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endSegment()
  return out
}

function skipHeredocs(s: string, start: number, delims: string[]): number {
  let i = start
  for (const delim of delims) {
    for (;;) {
      if (i >= s.length) return s.length
      const end = s.indexOf('\n', i)
      const line = s.slice(i, end === -1 ? s.length : end)
      i = end === -1 ? s.length : end + 1
      if (line.replace(/^\t+/, '') === delim) break
    }
  }
  return i
}

const REDIRECT = /^(?:\d*|&)(?:>>?|<<<|<)&?(.*)$/

function stripRedirects(words: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const m = words[i]!.match(REDIRECT)
    if (!m) out.push(words[i]!)
    else if (!m[1]) i++ // a bare operator: its target is the next word
  }
  return out
}

// ---------------------------------------------------------------- recognizing servers

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIXES = new Set(['nohup', 'exec', 'time', 'command', 'builtin', 'caffeinate', 'stdbuf', 'unbuffer', 'sudo', 'env'])

/** Drops `VAR=…`, nohup, env, timeout N, npx -y, uv run, yarn exec … in front of the real command. */
function unwrap(words: string[], env: Map<string, string>): string[] {
  let i = 0
  const flags = () => {
    while (words[i]?.startsWith('-')) i++
  }
  for (;;) {
    const w = words[i]
    if (w === undefined) return []
    if (ASSIGNMENT.test(w)) {
      const eq = w.indexOf('=')
      env.set(w.slice(0, eq), w.slice(eq + 1))
      i++
    } else if (PREFIXES.has(w)) {
      i++
      flags()
    } else if (w === 'nice') {
      i++
      if (words[i] === '-n') i += 2
      else flags()
    } else if (w === 'timeout' || w === 'gtimeout') {
      i++
      flags()
      i++ // the duration
    } else if (w === 'npx' || w === 'bunx' || w === 'pnpx') {
      i++
      flags()
    } else if (w === 'uv' && words[i + 1] === 'run') {
      i += 2
      flags()
    } else if ((w === 'yarn' || w === 'pnpm') && (words[i + 1] === 'exec' || words[i + 1] === 'dlx')) {
      i += 2
    } else {
      return words.slice(i)
    }
  }
}

/** Command words that start servers. Interpreters count too, but only their `--port` style flags do. */
const SERVERS = new Set([
  'wrangler', 'vite', 'astro', 'next', 'nuxt', 'nuxi', 'remix', 'react-router', 'webpack', 'webpack-dev-server',
  'http-server', 'serve', 'live-server', 'browser-sync', 'jekyll', 'hugo', 'eleventy', 'uvicorn', 'gunicorn',
  'hypercorn', 'flask', 'streamlit', 'jupyter', 'jupyter-lab', 'jupyter-notebook', 'mkdocs', 'hexo', 'gatsby',
  'docusaurus', 'storybook', 'start-storybook', 'parcel', 'esbuild', 'caddy', 'miniserve', 'php', 'rails',
  'lavish-axi', 'ng', 'vue-cli-service', 'vercel', 'netlify', 'expo', 'firebase', 'quasar', 'svelte-kit', 'rackup',
])
const INTERPRETERS = /^(node|tsx|ts-node|bun|deno|python(\d(\.\d+)?)?|ruby)$/
/** Tools where `-p N` means a port (elsewhere -p is often something else: ssh, mkdir, lsof). */
const DASH_P = new Set(['http-server', 'next', 'hugo', 'storybook', 'start-storybook', 'miniserve', 'flask', 'serve', 'rails', 'rackup', 'ruby'])
const PORT_FLAGS = /^--(port|server\.port|http-port|listen-port|dev-port)$/
const HOSTPORT_FLAGS = new Set(['-b', '--bind', '-a', '--dev-addr', '-S', '--listen', '-l', '--host-port'])

const asPort = (value: string | undefined): number | undefined => {
  const m = value?.match(/^(?:.*:)?(\d{2,5})$/)
  const port = m ? Number(m[1]) : NaN
  return port >= 1 && port <= 65535 ? port : undefined
}

const PACKAGE_RUNNERS = new Set(['yarn', 'npm', 'pnpm', 'bun'])
const RUNNER_BUILTINS = new Set(['install', 'add', 'remove', 'test', 'build', 'why', 'info', 'init', 'link', 'publish', 'up', 'upgrade', 'dlx', 'exec', 'workspace', 'workspaces', 'set', 'config', 'cache', 'x', 'ci', 'i', 'audit', 'outdated', 'version', 'pack', 'login', 'logout'])

/** `yarn dev`, `npm run dev`, `pnpm start`, `bun run dev` → the script text plus any extra arguments. */
function packageScript(words: string[], dir: string): string | undefined {
  const [word, first, second] = words
  const runner = basename(word ?? '')
  if (!PACKAGE_RUNNERS.has(runner)) return undefined
  let name: string | undefined
  let rest: string[]
  if (first === 'run' || first === 'run-script') {
    name = second
    rest = words.slice(3)
  } else if (first === 'start' && runner === 'npm') {
    name = 'start'
    rest = words.slice(2)
  } else if (runner === 'yarn' || runner === 'pnpm' || runner === 'bun') {
    name = first
    rest = words.slice(2)
  } else return undefined
  if (!name || RUNNER_BUILTINS.has(name) || name.startsWith('-')) return undefined
  const args = rest.filter(w => w !== '--')
  let script: string | undefined
  try {
    const file = join(dir, 'package.json')
    if (existsSync(file)) script = (JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> }).scripts?.[name]
  } catch {
    // unreadable package.json: treat as no script
  }
  if (script !== undefined) return [script, ...args].join(' ')
  // Without a script of that name, `yarn astro dev` / `pnpm vite` / `bun x.ts` run the binary or file itself.
  return runner === 'npm' ? undefined : [name, ...args].join(' ')
}

/** Ports a single (unwrapped) command would listen on. */
function portsOf(words: string[], env: Map<string, string>): { tool: string; ports: number[] } | undefined {
  const exe = basename(words[0] ?? '')
  const ports: number[] = []
  const lavish = asPort(env.get('LAVISH_AXI_PORT'))
  if (exe === 'lavish-axi' || words.some(w => w.includes('lavish-axi'))) {
    if (lavish) ports.push(lavish)
  }
  let tool = exe
  if (/^python(\d(\.\d+)?)?$/.test(exe)) {
    const m = words.indexOf('-m')
    const module = m >= 0 ? words[m + 1] : undefined
    if (module === 'http.server') {
      tool = 'http.server'
      const args = words.slice(m + 2)
      let positional: string | undefined
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (a === '--bind' || a === '-b' || a === '--directory' || a === '-d' || a === '--protocol') i++
        else if (!a.startsWith('-') && positional === undefined) positional = a
      }
      // No port argument means http.server's default 8000; a variable ($PORT) is unknown, so it is not checked.
      const port = positional === undefined ? 8000 : asPort(positional)
      if (port !== undefined) ports.push(port)
      return ports.length ? { tool, ports } : undefined
    }
    if (module) tool = module
  }
  const isServer = SERVERS.has(exe) || SERVERS.has(tool)
  const isInterpreter = INTERPRETERS.test(exe)
  if (!isServer && !isInterpreter) return ports.length ? { tool, ports } : undefined
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    const eq = w.indexOf('=')
    const flag = eq > 0 ? w.slice(0, eq) : w
    const inline = eq > 0 ? w.slice(eq + 1) : undefined
    let port: number | undefined
    if (PORT_FLAGS.test(flag)) port = asPort(inline ?? words[++i])
    else if (isServer && HOSTPORT_FLAGS.has(flag)) {
      const value = inline ?? words[i + 1]
      port = asPort(value)
      if (port !== undefined && inline === undefined) i++
    } else if (isServer && DASH_P.has(tool) && /^-p\d*$/.test(w)) port = asPort(w.length > 2 ? w.slice(2) : words[++i])
    else if (isServer && tool === 'jekyll' && w === '-P') port = asPort(words[++i])
    if (port !== undefined) ports.push(port)
  }
  const fromEnv = asPort(env.get('PORT'))
  if (fromEnv !== undefined && !ports.length) ports.push(fromEnv) // servers and scripts that read $PORT
  return ports.length ? { tool, ports } : undefined
}

/** Every server the command starts on an explicit (or http.server default) port. */
export function serverStarts(command: string, cwd: string, depth = 0): Start[] {
  const starts: Start[] = []
  let dir = cwd
  for (const segment of segments(command)) {
    const env = new Map<string, string>()
    const words = unwrap(segment, env)
    const exe = words[0]
    if (!exe) continue
    if (exe === 'cd') {
      const target = words[1]
      if (target && target !== '-') dir = resolve(dir, target.replace(/^~(?=\/|$)/, homedir()))
      continue
    }
    if (basename(exe) === 'portman' || words.includes('portman')) continue // already managed
    if (/^(ba|z|da)?sh$/.test(basename(exe)) && words.some(w => /^-\w*c$/.test(w)) && depth < 2) {
      const inner = words[words.findIndex(w => /^-\w*c$/.test(w)) + 1]
      if (inner) starts.push(...serverStarts(inner, dir, depth + 1))
      continue
    }
    const script = depth < 2 ? packageScript(words, dir) : undefined
    if (script !== undefined) {
      const prefix = [...env].map(([k, v]) => `${k}=${v}`).join(' ')
      for (const s of serverStarts(prefix ? `${prefix} ${script}` : script, dir, depth + 1)) starts.push(s)
      continue
    }
    const found = portsOf(words, env)
    if (found) for (const port of found.ports) starts.push({ port, tool: found.tool, dir, text: segment.join(' ') })
  }
  return starts
}
