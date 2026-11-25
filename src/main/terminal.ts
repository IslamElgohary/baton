/** Single-quote for POSIX sh. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Linux terminal emulators, most specific first, with the arguments that run a command in a new window.
 * `$TERMINAL` (a common convention, e.g. under i3/sway) wins; x-terminal-emulator (the Debian/Ubuntu default)
 * and xterm are fallbacks because their `-e` handling varies.
 */
const LINUX_TERMINALS: [string, string[]][] = [
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xfce4-terminal', ['-x']],
  ['kitty', []],
  ['alacritty', ['-e']],
  ['wezterm', ['start', '--']],
  ['foot', []],
  ['x-terminal-emulator', ['-e']],
  ['xterm', ['-e']]
]

export interface Launcher {
  bin: string
  args: string[]
  /** true: wait for `bin` to exit (it only hands off, like osascript); false: start it detached. */
  wait: boolean
}

/**
 * How to run `argv` in a new terminal window on `platform`, or null if no terminal app was found.
 * `find` resolves a program name on PATH. Never builds a shell string on Linux: argv is passed through.
 */
export function terminalLauncher(platform: NodeJS.Platform, argv: string[], find: (name: string) => string | null,
  env: NodeJS.ProcessEnv = process.env): Launcher | null {
  if (platform === 'darwin') {
    // AppleScript string inside `do script`: the command line is shell-quoted, then escaped for AppleScript.
    const line = argv.map(sq).join(' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return { bin: 'osascript', args: ['-e', `tell application "Terminal" to do script "${line}"`, '-e', 'tell application "Terminal" to activate'], wait: true }
  }
  if (platform === 'linux') {
    const candidates: [string, string[]][] = [...(env.TERMINAL ? [[env.TERMINAL, ['-e']] as [string, string[]]] : []), ...LINUX_TERMINALS]
    for (const [name, prefix] of candidates) {
      const bin = find(name)
      if (bin) return { bin, args: [...prefix, ...argv], wait: false }
    }
  }
  return null
}
