# portman

Owns every TCP port on this Mac: lists who listens where, reserves ports by name, blocks colliding server starts
(a Claude Code hook), and stops servers without taking down their terminal or agent.

## Install / update

    ./bin/install.sh

Copies this checkout to `~/.local/share/portman` (macOS won't let a launchd job read `~/Documents`), links
`~/.local/bin/portman` to the copy, and (re)starts the status page job `com.dawson.portman`.
**Re-run it after every change here**; until then the CLI, the hook, the dashboard and the status page run the old copy.

## Status page

http://my-macbook-pro:8899: read-only, answers only this Mac and the tailnet. Log: `~/Library/Logs/portman/serve.log`.

## Commands

    portman ls [--all] [--json]          what is listening (default: reachable from other machines)
    portman claim <name> [--port N]      reserve a port under a name; prints the port
    portman run <name> [--bind tailnet|loopback|all] [--detach] -- <command using {port} and {ip}>
    portman stop <name|port|id> [--unload]
    portman release <name>
    portman url <name>                   address the MacBook Air uses
    portman serve                        the status page (run by launchd)
    portman hook                         Claude Code PreToolUse hook (see ~/.claude/settings.json)

Registry: `~/.config/portman/registry.json`. Tests: `node --test`. Typecheck: `yarn tsc -p .`.
