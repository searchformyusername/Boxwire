// Minimal Chrome DevTools Protocol driver for Boxwire's browser checks (Node 22, no dependencies).
// Launches headless Chrome bound to 127.0.0.1 on its own debugging port with a throwaway profile, and offers
// page helpers: navigate, evaluate, real mouse clicks (trusted input events, so audio may start), viewport.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export async function launch({ port = 9333, headless = true } = {}) {
  const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'boxwire-cdp-'))
  const args = [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', ...(headless ? ['--headless=new'] : []), 'about:blank']
  const proc = spawn(CHROME, args, { stdio: 'ignore' })
  let version
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  if (!version) throw new Error('Chrome did not start')
  const close = () => {
    proc.kill('SIGTERM')
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500)
  }
  return { port, version, close }
}

export async function openPage(port, url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let id = 0
  const pending = new Map()
  const events = []
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method) {
      events.push(msg)
      // auto-attached workers: enable Runtime so their console errors and exceptions are recorded too
      if (msg.method === 'Target.attachedToTarget') {
        const sid = msg.params.sessionId
        send('Runtime.enable', {}, sid)
          .catch(() => {})
          .then(() => send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {}))
      }
    }
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  await send('Page.enable')
  await send('Runtime.enable')
  const page = {
    send,
    events,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      return r.result.value
    },
    async viewport(width, height, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
    },
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    },
    /** Real click at the centre of the first element matching a selector (after scrolling it into view). */
    async clickSelector(sel) {
      const r = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({block:'center', behavior:'instant'}); const b = el.getBoundingClientRect(); return {x: b.left + b.width/2, y: b.top + b.height/2} })()`)
      await page.click(r.x, r.y)
    },
    async waitFor(expr, ms = 20000) {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (await page.eval(expr)) return true
        await new Promise((r) => setTimeout(r, 200))
      }
      throw new Error('timeout waiting for ' + expr)
    },
    close: () => ws.close(),
  }
  return page
}
