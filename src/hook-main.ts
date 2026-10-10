// Entry for the PreToolUse hook only: loads just the parser and the port check, not the whole CLI, because it
// runs before every Bash call that mentions a port. Any failure lets the command run.
import { check, liveHolders, type HookInput } from './hook.ts'
import { load, projectOf } from './registry.ts'

let text = ''
try {
  for await (const chunk of process.stdin) text += chunk
  const reason = await check(JSON.parse(text) as HookInput, { registry: load(), holders: port => liveHolders(port), projectOf })
  if (reason) {
    process.stderr.write(`portman: ${reason}\n`)
    process.exitCode = 2
  }
} catch {
  process.exitCode = 0
}
