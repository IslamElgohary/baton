import { expect, test } from 'vitest'
import { terminalLauncher } from './terminal'

const only = (...names: string[]) => (n: string) => (names.includes(n) ? `/usr/bin/${n}` : null)

test('linux: picks an installed terminal and passes argv through untouched (no shell string)', () => {
  const argv = ['/usr/bin/pi', "it's", '--x']
  expect(terminalLauncher('linux', argv, only('gnome-terminal', 'xterm'), {}))
    .toEqual({ bin: '/usr/bin/gnome-terminal', args: ['--', ...argv], wait: false })
  expect(terminalLauncher('linux', argv, only('konsole'), {})).toEqual({ bin: '/usr/bin/konsole', args: ['-e', ...argv], wait: false })
  expect(terminalLauncher('linux', argv, only('kitty'), {})).toEqual({ bin: '/usr/bin/kitty', args: argv, wait: false })
  expect(terminalLauncher('linux', argv, only('xterm'), {})?.bin).toBe('/usr/bin/xterm')
})

test('linux: $TERMINAL wins; nothing installed → null', () => {
  expect(terminalLauncher('linux', ['pi'], only('foot', 'gnome-terminal'), { TERMINAL: 'foot' }))
    .toEqual({ bin: '/usr/bin/foot', args: ['-e', 'pi'], wait: false })
  expect(terminalLauncher('linux', ['pi'], () => null, {})).toBeNull()
})

test('macOS: Terminal.app via osascript with quoting for sh, then AppleScript', () => {
  const l = terminalLauncher('darwin', ['/opt/pi', 'a "b"', "c'd"], () => null)!
  expect(l.bin).toBe('osascript')
  expect(l.wait).toBe(true)
  expect(l.args[1]).toBe(`tell application "Terminal" to do script "'/opt/pi' 'a \\"b\\"' 'c'\\\\''d'"`)
})

test('other platforms: no launcher yet', () => {
  expect(terminalLauncher('win32', ['pi'], () => 'C:\\x.exe')).toBeNull()
})
