import { execFile } from 'node:child_process'

/**
 * Runs a command and resolves with its stdout. A non-zero exit still resolves (lsof exits 1 when it finds nothing);
 * only a missing binary or a timeout rejects.
 */
export type Exec = (cmd: string, args: string[], env?: Record<string, string>) => Promise<string>

export const exec: Exec = (cmd, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: 10_000, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout) => {
        if (err && (err.killed || typeof err.code === 'string')) reject(err)
        else resolve(stdout)
      },
    )
  })
