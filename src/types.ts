/** What a listening socket accepts: only this Mac, the tailnet, one LAN address, or every interface. */
export type Scope = 'loopback' | 'tailnet' | 'lan' | 'all'

/** Who owns a listener; decides whether `portman stop` may touch it. */
export type Kind = 'service' | 'container' | 'system' | 'agent-helper' | 'app' | 'dev'

export interface Socket {
  /** '*' for a wildcard bind, otherwise the literal address ('127.0.0.1', '::1', '100.101.102.103'). */
  address: string
  port: number
  family: 'IPv4' | 'IPv6'
  /** An IPv6 wildcard that also accepts IPv4 (netstat calls it tcp46). */
  dualStack: boolean
  scope: Scope
  pid: number
}

export interface Proc {
  pid: number
  ppid: number
  pgid: number
  uid: number
  stat: string
  tty: string
  /** Seconds since the epoch; with the pid it identifies one process even after the pid is reused. */
  startEpoch: number
  command: string
}

/** One server: the listening sockets of a process group. */
export interface App {
  /** `<pid>-<startEpoch>` of the process holding the main port. */
  id: string
  pid: number
  pgid: number
  uid: number
  name: string
  kind: Kind
  command: string
  cwd?: string
  launchd?: string
  /** Name of the reservation this app holds, when it matches the reservation's owner. */
  reservation?: string
  /** The port people use: a reserved one, else the lowest exposed one, else the lowest. */
  port: number
  /** Every port except loopback ephemeral ones, main port first. */
  ports: number[]
  /** Loopback ports ≥ 49152 (inspectors, internal RPC), collapsed into a count. */
  internal: number
  sockets: Socket[]
  /** Widest scope among the main port's sockets. */
  scope: Scope
  /** Reachable from another machine on any non-internal port. */
  exposed: boolean
  url?: string
  startedAt: string
}

export interface Conflict {
  port: number
  /** App ids involved (empty for a reservation held by nobody it names). */
  apps: string[]
  explanation: string
}

export interface Reservation {
  port: number
  kind: 'service' | 'preview'
  /** Directory of the owning project; a server whose cwd is inside it owns the port. */
  project?: string
  /** launchd label of the owning job. */
  launchd?: string
  note?: string
  createdAt: string
}

export interface Registry {
  schema: 1
  /** Ports handed out by `claim` when no port is given. */
  pool: [number, number]
  /** Hostname the MBA uses for this Mac (MagicDNS); defaults to the local hostname. */
  host?: string
  reservations: Record<string, Reservation>
}

export interface Snapshot {
  schema: 1
  scannedAt: string
  host: string
  tailnetIp: string | null
  apps: App[]
  conflicts: Conflict[]
  /** Reservations nobody is listening on right now. */
  idle: Array<Reservation & { name: string }>
}
