// Renders build/icon.svg to build/icon.png (1024²) and build/icon.icns. Run: npm run icon
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1') // 1 CSS px = 1 image px
app.dock?.hide()
app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', 'build')
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`))
  await new Promise((r) => setTimeout(r, 300))
  // Retina screens capture at 2x regardless of the switch: normalize to exactly 1024².
  const png = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' }).toPNG()
  fs.writeFileSync(path.join(dir, 'icon.png'), png)

  // macOS iconset: 16…512 at 1x and 2x, then iconutil → .icns
  const set = path.join(dir, 'icon.iconset')
  fs.rmSync(set, { recursive: true, force: true })
  fs.mkdirSync(set)
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const out = path.join(set, `icon_${s}x${s}${suffix}.png`)
      execFileSync('sips', ['-z', String(s * scale), String(s * scale), path.join(dir, 'icon.png'), '--out', out], { stdio: 'ignore' })
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(dir, 'icon.icns')])
  fs.rmSync(set, { recursive: true, force: true })
  console.log('wrote build/icon.png and build/icon.icns')
  app.quit()
})
