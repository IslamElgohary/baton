import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ExecResult } from './harnesses/types'

/** execFile that never throws: returns the exit code and output. */
export function exec(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) })
      })
  })
}

/**
 * GUI-launched apps (Finder, a Linux desktop launcher) get a minimal PATH. Copy the login shell's PATH so
 * CLIs installed via Homebrew / npm / ~/.local/bin are found.
 */
export async function adoptLoginShellPath(): Promise<void> {
  if (process.platform === 'win32') return // Windows apps inherit the user's PATH
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  // `env` prints the exported, colon-joined PATH in bash, zsh and fish alike (fish's "$PATH" would be space-joined).
  const r = await exec(shell, ['-ilc', 'env'], { timeoutMs: 10_000 })
  const path = r.stdout.split('\n').filter((l) => l.startsWith('PATH=')).pop()?.slice(5)
  if (path) process.env.PATH = path
}

/** Absolute path of `name` on PATH, or null. Absolute paths are checked as-is. */
export function which(name: string): string | null {
  const candidates = name.includes('/') ? [name] : (process.env.PATH ?? '').split(delimiter).map((d) => join(d, name))
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); return c } catch { /* next */ }
  }
  return null
}
