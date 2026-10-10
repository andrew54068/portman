# Security Policy

## Supported versions

Only the latest release gets fixes.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a vulnerability

**Please don't report security problems in public issues, discussions or pull requests.**

Report them privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Please include:

- what the problem is and what an attacker could do with it
- steps to reproduce, ideally a proof of concept
- the portman version or commit, and your macOS and Node.js versions

You'll get an acknowledgement within 7 days. Once a fix is ready, we'll agree on a disclosure date, and you'll be
credited in the release notes unless you'd rather not be.

## Scope

portman runs with your user's permissions. The parts that matter most:

- the status page (`portman serve`): it should answer only loopback and tailnet clients, only for this Mac's own
  host names, and never run or render anything from the scan as HTML
- `portman stop`: it must never signal a process it wasn't asked to stop
- the Claude Code hook: it must never run a command it reads
