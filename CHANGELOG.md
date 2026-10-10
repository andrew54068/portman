# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-11

First public release.

### Added

- `portman ls`: every TCP listener on the Mac in one table, built from `lsof`, `netstat`, `ps` and `launchctl`,
  with conflicts (a narrower bind shadowing a wildcard one, or `localhost` split between `127.0.0.1` and `[::1]`)
  explained first.
- `portman claim` and `portman release`: named port reservations owned by a project folder or a launchd job.
- `portman run`: start a server on its reserved port, optionally detached, and print the URL other tailnet devices
  use.
- `portman stop`: stop a server by name, port or listener id without signalling terminals, agents or portman's
  caller; launchd jobs need `--unload`.
- `portman hook`: a Claude Code `PreToolUse` hook that blocks server starts on ports that are taken or reserved.
- `portman serve`: a read-only status page for this Mac and the tailnet, kept running by a LaunchAgent.

[Unreleased]: https://github.com/andrew54068/portman/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/andrew54068/portman/releases/tag/v0.1.0
