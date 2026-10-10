// Today's MBP, trimmed: the hub on *:8790 shadowed by the talk's workerd on the Tailscale IP, two dashboard backends
// splitting localhost:4567, and one listener of every kind.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { snapshotFrom, type Raw } from '../scan.ts'
import type { Registry } from '../types.ts'

const fixture = (name: string) => readFileSync(join(import.meta.dirname, `incident.${name}.txt`), 'utf8')

export const raw: Raw = { lsof: fixture('lsof'), netstat: fixture('netstat'), ps: fixture('ps'), launchctl: fixture('launchctl') }

export const registry: Registry = {
  schema: 1,
  pool: [8800, 8899],
  reservations: {
    'home-hub': {
      port: 8790,
      kind: 'service',
      project: '/Users/me/Documents/tools/home-hub',
      launchd: 'com.example.home-hub',
      createdAt: '2026-10-10T00:00:00.000Z',
    },
    'dashboard-backend': { port: 4567, kind: 'service', project: '/Users/me/Documents/SideProjects/dashboard', createdAt: '2026-10-10T00:00:00.000Z' },
    'mlx-whisper': { port: 8123, kind: 'service', launchd: 'com.example.mlx-whisper', createdAt: '2026-10-10T00:00:00.000Z' },
  },
}

const ctx = { registry, host: 'my-macbook-pro', tailnetIp: '100.101.102.103', now: new Date('2026-10-10T08:00:00Z') }
export const incident = () => snapshotFrom(raw, fixture('cwd'), 501, ctx)
