# Contributing to portman

Thanks for helping. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need macOS and Node.js 24.4 or newer (see [Requirements](README.md#requirements)).

```sh
git clone https://github.com/andrew54068/portman.git
cd portman
yarn install     # TypeScript and @types/node, for type checking only
node --test      # every test should pass before you change anything
```

Node runs the `.ts` sources directly, so there is no build step. Try your change with `bin/portman <command>`
from the checkout; run `bin/install.sh` only when you want it to replace your installed copy.

## Make a change

1. Branch from `main`: `git checkout -b fix/short-description`.
2. Keep the change focused, and add or update a test in the matching `src/*.test.ts`. Tests read captured command
   output (see `src/fixtures/`), never the live machine, and must never signal real processes.
3. Run both checks:
   ```sh
   node --test
   yarn typecheck
   ```
4. Open a pull request against `main` that says what changed and why.

Two rules shape most of the code; please keep them:

- **portman never breaks the thing it guards.** The hook lets a command run whenever portman itself fails, and
  `stop` refuses rather than guesses.
- **No runtime dependencies.** Only Node's standard library and the macOS tools portman already reads.

## Fixtures

If you capture new `lsof`, `netstat`, `ps` or `launchctl` output for a fixture, replace your hostname, Tailscale
addresses, user name and project paths with neutral ones (for example `my-macbook-pro`, `100.101.102.103` and
`/Users/me`) before you commit it.

## Bugs and ideas

Open an issue with the matching template. For security problems, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.
