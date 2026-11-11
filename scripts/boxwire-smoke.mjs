// Exercise the standalone app through its UI, against either Vite or the production preview.
// node scripts/boxwire-smoke.mjs [baseUrl] [report.json]
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, openPage } from './lib/cdp.mjs'

const base = process.argv[2] || 'http://127.0.0.1:5173'
const downloads = mkdtempSync(join(tmpdir(), 'boxwire-downloads-'))
const chrome = await launch({ port: 9358 })
const checks = []
let page
const check = (name, ok) => {
  assert.ok(ok, name)
  checks.push(name)
  console.log('PASS: ' + name)
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  page = await openPage(chrome.port, `${base}/`)
  await page.viewport(1440, 1000)
  await page.waitFor('!!document.querySelector(".bw-canvas")')
  check('homepage opens the standalone editor', await page.eval(`!document.querySelector('a[href="/products"]') && document.title.startsWith('Boxwire')`))
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  const clickText = async (selector, text) => {
    const point = await page.eval(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim().startsWith(${JSON.stringify(text)}))
      if (!el) throw new Error('Control not found: ' + ${JSON.stringify(text)})
      el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    })()`)
    await page.click(point.x, point.y)
  }
  const importFile = async (file) => {
    const { result } = await page.send('Runtime.evaluate', { expression: 'document.querySelector(".bw > input[type=file]")' })
    await page.send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId })
  }
  const exported = async (label, suffix) => {
    for (const name of readdirSync(downloads).filter(name => name.endsWith(suffix))) rmSync(join(downloads, name))
    await page.clickSelector('button[aria-label="Export"]')
    await clickText('[role=menuitem]', label)
    const until = Date.now() + 30000
    while (Date.now() < until) {
      const file = readdirSync(downloads).find(name => name.endsWith(suffix))
      if (file) return join(downloads, file)
      await pause(100)
    }
    throw new Error('No completed download for ' + label)
  }

  await importFile(fileURLToPath(new URL('../public/products/boxwire/examples/system-architecture.boxwire-diagram.json', import.meta.url)))
  await page.waitFor(`document.querySelector('[aria-label="Board name"]')?.value === 'URL shortener'`)
  await page.waitFor('document.querySelector(".bw-save")?.textContent.includes("Saved on this device")')
  const first = JSON.parse(readFileSync(await exported('Board file', '.json'), 'utf8'))
  check('diagram import and board export preserve content', first.format === 'boxwire' && Object.values(first.board.doc).filter(el => el.type === 'edge').length > 0)

  const nodeCount = Object.values(first.board.doc).filter(el => el.type !== 'edge').length
  await page.clickSelector('button[aria-label="Box (R)"]')
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 950, y: 700, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1100, y: 800, button: 'left', buttons: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1100, y: 800, button: 'left', clickCount: 1 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  const drawn = JSON.parse(readFileSync(await exported('Board file', '.json'), 'utf8'))
  check('canvas drawing adds a node', Object.values(drawn.board.doc).filter(el => el.type !== 'edge').length === nodeCount + 1)
  await page.clickSelector('button[aria-label="Undo (⌘Z)"]')
  const undone = JSON.parse(readFileSync(await exported('Board file', '.json'), 'utf8'))
  check('undo restores the imported diagram', JSON.stringify(undone.board.doc) === JSON.stringify(first.board.doc))
  await page.clickSelector('button[aria-label="Redo (⇧⌘Z)"]')
  const redoneFile = await exported('Board file', '.json')
  const redone = JSON.parse(readFileSync(redoneFile, 'utf8'))
  const roundtrip = join(downloads, 'roundtrip.input')
  writeFileSync(roundtrip, JSON.stringify(redone))
  check('redo restores the drawn node', JSON.stringify(redone.board.doc) === JSON.stringify(drawn.board.doc))

  const png = readFileSync(await exported('PNG image', '.png'))
  check('PNG export downloads a valid image', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
  const svg = readFileSync(await exported('SVG (vector)', '.svg'), 'utf8')
  check('SVG export includes diagram labels', svg.includes('<svg') && svg.includes('Shortener API'))
  const pdf = readFileSync(await exported('PDF, one page', '.pdf'))
  check('PDF export downloads a valid document', pdf.subarray(0, 5).toString() === '%PDF-')

  await page.clickSelector('button[aria-label^="Review"]')
  await page.waitFor('!!document.querySelector(".bw-review")')
  check('architecture review opens', await page.eval('document.querySelector(".bw-review").textContent.includes("Capacity")'))
  await page.clickSelector('button[aria-label="Dark mode"]')
  await page.waitFor('!!document.querySelector(".bw.is-dark")')
  await page.waitFor('document.querySelector(".bw-save")?.textContent.includes("Saved on this device")')
  await page.send('Page.reload')
  await page.waitFor(`document.querySelector('[aria-label="Board name"]')?.value === 'URL shortener' && !!document.querySelector('.bw.is-dark')`)
  const reloaded = JSON.parse(readFileSync(await exported('Board file', '.json'), 'utf8'))
  check('reload preserves board, history, and theme', JSON.stringify(reloaded.board) === JSON.stringify(redone.board))

  await importFile(roundtrip)
  await pause(500)
  const reopened = JSON.parse(readFileSync(await exported('Board file', '.json'), 'utf8'))
  check('exported board reopens with the same history', JSON.stringify(reopened.board) === JSON.stringify(redone.board))
  await page.clickSelector('button[aria-label="Timelapse"]')
  await page.waitFor('!!document.querySelector(".bw-replay")')
  check('timelapse opens with the recorded board', await page.eval('document.querySelector(".bw-replay").textContent.includes("Timelapse")'))
  await page.waitFor('Number(document.querySelector("[aria-label=Timeline]")?.value) > 0')
  check('timelapse playback advances and renders', await page.eval('document.querySelector(".bw-replay-canvas").width > 0'))
  await page.send('Page.navigate', { url: `${base}/products/boxwire` })
  await page.waitFor('!!document.querySelector(".bw-canvas")')
  check('original Boxwire route still opens', await page.eval(`document.querySelector('[aria-label="Board name"]').value === 'URL shortener'`))
  for (const path of ['/products/boxwire/llm.md', '/products/boxwire/schema.json', '/products/boxwire/examples/er-schema.boxwire-diagram.json']) {
    const response = await fetch(base + path)
    check('local asset: ' + path, response.ok && !(await response.text()).includes('<!doctype html>'))
  }
  check('no uncaught browser exceptions', !page.events.some(event => event.method === 'Runtime.exceptionThrown'))
  const report = { base, chrome: chrome.version.Browser, checks, ok: true }
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  page?.close()
  chrome.close()
  rmSync(downloads, { recursive: true, force: true })
}
