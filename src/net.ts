import { hostname, networkInterfaces } from 'node:os'
import type { Scope } from './types.ts'

export const isWildcard = (a: string) => a === '*' || a === '0.0.0.0' || a === '::'
export const isLoopback = (a: string) => a === '::1' || a === 'localhost' || a.startsWith('127.')

/** 100.64.0.0/10 or Tailscale's fd7a:115c:a1e0::/48. */
export function isTailnet(a: string): boolean {
  const m = a.match(/^100\.(\d+)\./)
  return (m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127) || a.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

export function scopeOf(address: string): Scope {
  if (isWildcard(address)) return 'all'
  if (isLoopback(address)) return 'loopback'
  if (isTailnet(address)) return 'tailnet'
  return 'lan'
}

const WIDTH: Record<Scope, number> = { loopback: 0, lan: 1, tailnet: 2, all: 3 }
export const widest = (scopes: Scope[]): Scope =>
  scopes.reduce<Scope>((a, b) => (WIDTH[b] > WIDTH[a] ? b : a), 'loopback')

/** This Mac's Tailscale IPv4 (a utun address in 100.64/10), or null while Tailscale is down. */
export function tailnetIp(): string | null {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!name.startsWith('utun')) continue
    for (const a of addrs ?? []) if (a.family === 'IPv4' && isTailnet(a.address)) return a.address
  }
  return null
}

/** MagicDNS short name: "My-MacBook-Pro.local" → "my-macbook-pro". */
export const defaultHost = () => hostname().toLowerCase().replace(/\.local$/, '')

/** "[::1]" style for IPv6 so "address:port" stays readable. */
export const fmtAddress = (a: string) => (a.includes(':') ? `[${a}]` : a)
