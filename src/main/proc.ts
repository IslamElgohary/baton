import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ExecResult } from './harnesses/types'

/** execFile that never throws: returns the exit code and output. */
export function exec(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) })
      })
  })
}

/**
 * Apps launched from Finder get a minimal PATH. Copy the login shell's PATH so
 * CLIs installed via Homebrew / npm / ~/.local/bin are found.
 */
export async function adoptLoginShellPath(): Promise<void> {
  const shell = process.env.SHELL || '/bin/zsh'
  const r = await exec(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeoutMs: 10_000 })
  const m = r.stdout.match(/__PATH__(.*)__PATH__/)
  if (m?.[1]) process.env.PATH = m[1]
}

/** Absolute path of `name` on PATH, or null. Absolute paths are checked as-is. */
export function which(name: string): string | null {
  const candidates = name.includes('/') ? [name] : (process.env.PATH ?? '').split(delimiter).map((d) => join(d, name))
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); return c } catch { /* next */ }
  }
  return null
}
