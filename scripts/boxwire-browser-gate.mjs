// Browser gate for Boxwire, in a real headless Chrome bound to 127.0.0.1 with its own profile and port.
// Starts Vite (127.0.0.1:5218) unless --url is given, and exits non-zero on any failure.
//   mise exec node@22.23.2 -- node scripts/boxwire-browser-gate.mjs [--url http://127.0.0.1:5217] [--out file.json]
// A. Accessible names at 375 px: every button, menu item, checkbox, radio, link and text field in the
//    accessibility tree (toolbar, top bar, Boards and Export menus open) has a non-empty computed name.
// C. The same merge by keyboard alone (Tab / Shift+Tab / arrows / Space / Enter / typing): focus always
//    visible and never stuck, each card a named group, cards resolved keep / take / write, board opened.
// B. Merge with conflict cards: the change review's "merge someone else's edit" takes a common original,
//    your version and theirs; a clean change merges on its own, the conflicting field is a card; resolving it
//    by writing a value and opening the merge as a board gives a board whose source has both changes.
// D. The header box is its own choice: re-importing a Mermaid file onto a board from an earlier import,
//    with a model change ticked, keeps the board's header when the box is unticked and takes the new one
//    when it is ticked (the patch shown and the opened board's source agree).

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEBUG_PORT = 9347
const failures = [], report = {}
const check = (ok, msg) => { if (!ok) failures.push(msg) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const children = []
const cleanup = () => { for (const c of children) try { c.kill('SIGTERM') } catch { /* gone */ } }
process.on('exit', cleanup)

async function waitFor(url, ms = 30000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* not yet */ }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${url}`)
    await sleep(250)
  }
}

let base = arg('url')
if (!base) {
  base = 'http://127.0.0.1:5218'
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5218', '--strictPort', '--host', '127.0.0.1'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' })
  children.push(vite)
}
await waitFor(`${base}/products/boxwire`)

const profile = mkdtempSync(join(tmpdir(), 'boxwire-gate-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
children.push(chrome)
await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
const target = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const pending = new Map()
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++seq
  pending.set(n, { resolve, reject })
  ws.send(JSON.stringify({ id: n, method, params }))
})
const js = async (body) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const until = async (body, ms = 15000) => {
  const t0 = Date.now()
  for (;;) {
    if (await js(body)) return true
    if (Date.now() - t0 > ms) return false
    await sleep(150)
  }
}
await send('Page.enable')
await send('Runtime.enable')
await send('Accessibility.enable')
await send('DOM.enable')

const HELPERS = `
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim().startsWith(text) || el.getAttribute('aria-label') === text)
  const click = (sel, text) => { const el = byText(sel, text); if (!el) throw new Error('no ' + sel + ' ' + text); el.click(); return true }
`

try {
  // ---- A. accessible names at 375 px -------------------------------------------------------------------
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: `${base}/products/boxwire` })
  check(await until(`return !!document.querySelector('.bw-canvas')`), 'A: the board did not load at 375 px')
  const ROLES = new Set(['button', 'menuitem', 'checkbox', 'radio', 'link', 'textbox', 'combobox', 'menuitemcheckbox', 'switch', 'tab', 'slider', 'spinbutton', 'popUpButton'])
  const unnamed = async (where) => {
    const { nodes } = await send('Accessibility.getFullAXTree')
    return nodes.filter((n) => !n.ignored && ROLES.has(n.role?.value) && !String(n.name?.value ?? '').trim()).map((n) => `${where}: ${n.role.value} (backend ${n.backendDOMNodeId})`)
  }
  await until(`return document.querySelectorAll('button[aria-haspopup="menu"]').length >= 2`)
  const missing = [...await unnamed('board')]
  let controls = (await send('Accessibility.getFullAXTree')).nodes.filter((n) => !n.ignored && ROLES.has(n.role?.value)).length
  for (const menu of ['Boards', 'Export']) {
    await js(`${HELPERS} click('.bw-topbar button[aria-haspopup="menu"]', ${JSON.stringify(menu)})`)
    await sleep(200)
    missing.push(...await unnamed(`${menu} menu open`))
    controls += (await send('Accessibility.getFullAXTree')).nodes.filter((n) => !n.ignored && n.role?.value === 'menuitem').length
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); return true`)
    await sleep(150)
  }
  const exportName = await js(`${HELPERS} const b = byText('.bw-topbar button[aria-haspopup="menu"]', 'Export'); return b ? (b.getAttribute('aria-label') ?? '') : null`)
  check(missing.length === 0, `A: ${missing.length} control(s) without an accessible name at 375 px: ${missing.slice(0, 8).join('; ')}`)
  check(exportName === 'Export', `A: the Export menu button is named ${JSON.stringify(exportName)}`)
  report.accessibleNames = { width: 375, controlsChecked: controls, unnamed: missing.length, exportName }

  // ---- B. merge with conflict cards ---------------------------------------------------------------------
  await send('Emulation.clearDeviceMetricsOverride')
  await send('Page.navigate', { url: `${base}/products/boxwire` })
  check(await until(`return !!document.querySelector('.bw-canvas') && document.querySelectorAll('.bw-topbar button[aria-haspopup="menu"]').length >= 2`), 'B: the board did not load')
  await js(`${HELPERS}
    let base = null
    for (let i = 0; i < 10 && !base; i++) {
      try { base = await (await fetch('/src/products/boxwire/source/fixtures/review-baseline.boxwire.jsonc')).text() } catch { await new Promise((r) => setTimeout(r, 500)) }
    }
    if (!base) throw new Error('the fixture could not be loaded')
    window.__mergeTexts = {
      base,
      ours: base.replace('"label": "API gateway"', '"label": "Gateway A"').replace('"label": "Catalog API"', '"label": "Catalog (ours)"'),
      theirs: base.replace('"label": "API gateway"', '"label": "Gateway B"').replace('"label": "Order worker"', '"label": "Order worker (theirs)"'),
    }
    click('.bw-topbar button[aria-haspopup="menu"]', 'Boards')
    await new Promise((r) => setTimeout(r, 150))
    click('[role=menuitem]', 'Review an architecture change')
    return true`)
  check(await until(`return !!document.querySelector('#bw-cr-merge-h')`), 'B: the change review has no merge section')
  await js(`${HELPERS}
    const t = window.__mergeTexts
    const put = (labelText, text, name) => {
      const label = [...document.querySelectorAll('.bw-cr-pick label')].find((l) => l.textContent.trim().startsWith(labelText))
      const input = label.querySelector('input[type=file]')
      const dt = new DataTransfer(); dt.items.add(new File([text], name, { type: 'application/json' }))
      input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    put('Common original', t.base, 'original.boxwire.jsonc')
    put('Your version', t.ours, 'mine.boxwire.jsonc')
    put('Their version', t.theirs, 'theirs.boxwire.jsonc')
    return true`)
  await until(`return [...document.querySelectorAll('.bw-cr-pick .bw-decl-note')].some((s) => s.textContent.includes('theirs.boxwire.jsonc'))`)
  await js(`${HELPERS} click('button', 'Merge'); return true`)
  check(await until(`return !!document.querySelector('.bw-merge')`), 'B: no merge view after Merge')
  const cards = await js(`return [...document.querySelectorAll('.bw-merge-card legend')].map((l) => l.textContent)`)
  const status = await js(`return document.querySelector('.bw-merge [role=status]')?.textContent ?? ''`)
  check(cards.length === 1 && /label/.test(cards[0]), `B: expected one card for the label conflict, got ${JSON.stringify(cards)}`)
  check(/2 changes merged without conflict/.test(status), `B: status ${JSON.stringify(status)}`)
  const disabledBefore = await js(`${HELPERS} return byText('button', 'Open merged as a board').disabled`)
  check(disabledBefore === true, 'B: "Open merged as a board" is enabled before the card is resolved')
  await js(`
    const radio = [...document.querySelectorAll('.bw-merge-card input[type=radio]')][2]
    radio.click()
    await new Promise((r) => setTimeout(r, 100))
    const ta = document.querySelector('.bw-merge-edit textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'Gateway (A + B)'); ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true`)
  check(await until(`return ![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Open merged as a board')).disabled`), 'B: "Open merged as a board" stays disabled after resolving the card')
  await js(`${HELPERS} click('button', 'Open merged as a board'); return true`)
  check(await until(`return !document.querySelector('.bw-change')`), 'B: the dialog did not close after opening the merge')
  await sleep(500)
  await js(`${HELPERS}
    click('.bw-topbar button[aria-haspopup="menu"]', 'Boards')
    await new Promise((r) => setTimeout(r, 150))
    click('[role=menuitem]', 'Source file of this board')
    return true`)
  check(await until(`return !!document.querySelector('.bw-source-text')`), 'B: the merged board has no source panel')
  const merged = await js(`return document.querySelector('.bw-source-text')?.value ?? ''`)
  for (const want of ['"label": "Gateway (A + B)"', '"label": "Catalog (ours)"', '"label": "Order worker (theirs)"', '// Review baseline']) check(merged.includes(want), `B: the merged source lacks ${want}`)
  report.merge = { cards: cards.length, status, opened: merged.length > 0 }

  // ---- C. the same merge by keyboard alone ----------------------------------------------------------------
  // Only Tab, Shift+Tab, arrows, Space, Enter and typing. Files go into the focused file input the way the
  // browser's own file chooser would (DOM.setFileInputFiles on the focused element). Every focus stop must
  // show a visible focus indicator, every Tab must move focus, and each card must be a named group.
  const KEYS = { Tab: 9, Enter: 13, ' ': 32, ArrowDown: 40, ArrowRight: 39, Escape: 27, a: 65 }
  const press = async (key, modifiers = 0) => {
    const code = key === ' ' ? 'Space' : key === 'a' ? 'KeyA' : key
    const base = { key, code, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key], modifiers }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(key === ' ' && { text: ' ' }) })
    if (key === ' ' || key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: key === ' ' ? ' ' : '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(60)
  }
  const FOCUS = `
    const a = document.activeElement
    const visible = (el) => { if (!el || el === document.body) return false; const st = getComputedStyle(el); return (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0) || st.boxShadow !== 'none' }
    const label = a?.closest?.('label')
    const shown = visible(a) || (a?.classList?.contains('bw-file-input') && visible(label))
    const name = (a?.getAttribute?.('aria-label') || label?.textContent || a?.textContent || a?.value || '').trim().replace(/\\s+/g, ' ').slice(0, 60)
    window.__gid ??= 0
    if (a && !a.__gid) a.__gid = ++window.__gid
    return { id: a?.__gid ?? 0, tag: a?.tagName, type: a?.type ?? null, name, shown, inDialog: !!a?.closest?.('[role=dialog]') }
  `
  const focusTrail = [], hidden = []
  let stuck = 0
  let lastId = null
  const tab = async (shift = false) => {
    await press('Tab', shift ? 8 : 0)
    const f = await js(FOCUS)
    focusTrail.push(`${f.tag}${f.type ? `[${f.type}]` : ''} ${f.name}`)
    if (!f.shown) hidden.push(`${f.tag} ${f.name}`)
    if (f.id === lastId) stuck++
    lastId = f.id
    return f
  }
  /** Tab forward until the focused element matches `test` (a JS expression over `a`, the active element). */
  const tabTo = async (test, max = 80) => {
    for (let i = 0; i < max; i++) {
      const f = await tab()
      if (await js(`const a = document.activeElement; return !!(${test})`)) return f
    }
    failures.push(`C: never reached ${test} by Tab`)
    return null
  }
  const KB = `{ ...window.__mergeTexts }`
  await send('Page.navigate', { url: `${base}/products/boxwire` })
  check(await until(`return !!document.querySelector('.bw-canvas') && document.querySelectorAll('.bw-topbar button[aria-haspopup="menu"]').length >= 2`), 'C: the board did not load')
  // three conflicting fields, to resolve one each way; plus a clean change on each side
  const texts = await js(`
    const base = await (await fetch('/src/products/boxwire/source/fixtures/review-baseline.boxwire.jsonc')).text()
    const r = (t, pairs) => pairs.reduce((x, [a, b]) => x.replace(a, b), t)
    return {
      base,
      ours: r(base, [['"label": "API gateway"', '"label": "Gateway A"'], ['"label": "Catalog API"', '"label": "Catalog A"'], ['"label": "Order worker"', '"label": "Worker A"'], ['"label": "Orders DB"', '"label": "Orders DB (ours)"']]),
      theirs: r(base, [['"label": "API gateway"', '"label": "Gateway B"'], ['"label": "Catalog API"', '"label": "Catalog B"'], ['"label": "Order worker"', '"label": "Worker B"'], ['"label": "Card processor"', '"label": "Card processor (theirs)"']]),
    }`)
  void KB
  const dir = mkdtempSync(join(tmpdir(), 'boxwire-merge-'))
  const files = { base: join(dir, 'original.boxwire.jsonc'), ours: join(dir, 'mine.boxwire.jsonc'), theirs: join(dir, 'theirs.boxwire.jsonc') }
  for (const k of Object.keys(files)) writeFileSync(files[k], texts[k])
  // from the canvas, by the palette (Cmd+K, type, Enter): a new blank board (no source file, so "your
  // version" is a file too), then the change review
  const palette = async (text) => {
    await js(`document.querySelector('.bw-canvas')?.focus(); return true`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 4 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 4 })
    await sleep(250)
    await send('Input.insertText', { text })
    await sleep(150)
    await press('Enter')
    await sleep(400)
  }
  await palette('New blank board')
  check(await until(`return document.querySelector('[aria-label="Board name"]')?.value === 'Untitled board' || !document.querySelector('.bw-source')`), 'C: no new blank board')
  await palette('Review an architecture')
  check(await until(`return !!document.querySelector('#bw-cr-merge-h')`), 'C: the palette did not open the change review')
  const putFile = async (path) => {
    const { result } = await send('Runtime.evaluate', { expression: 'document.activeElement' })
    await send('DOM.setFileInputFiles', { files: [path], objectId: result.objectId })
    await sleep(150)
  }
  const inLabel = (text) => `a.type === 'file' && a.closest('label')?.textContent.trim().startsWith(${JSON.stringify(text)})`
  if (await tabTo(inLabel('Common original'))) await putFile(files.base)
  if (await tabTo(inLabel('Your version'))) await putFile(files.ours)
  if (await tabTo(inLabel('Their version'))) await putFile(files.theirs)
  // never trapped: Shift+Tab goes back, Tab returns
  const here = await js(FOCUS)
  const back = await tab(true), fwd = await tab()
  check(back.id !== here.id && fwd.id === here.id, 'C: Shift+Tab then Tab did not move away and back')
  if (await tabTo(`a.tagName === 'BUTTON' && a.textContent.trim() === 'Merge'`)) await press('Enter')
  check(await until(`return document.querySelectorAll('.bw-merge-card').length === 3`), 'C: expected three cards after Merge')
  // each card a named group (fieldset + legend), with a named radio group inside
  const { nodes } = await send('Accessibility.getFullAXTree')
  const groups = nodes.filter((n) => !n.ignored && n.role?.value === 'group' && /changed label/.test(n.name?.value ?? ''))
  const radiogroups = nodes.filter((n) => !n.ignored && n.role?.value === 'radiogroup' && /^Resolve: /.test(n.name?.value ?? ''))
  check(groups.length === 3, `C: ${groups.length} cards have a group name from their legend, expected 3`)
  check(radiogroups.length === 3, `C: ${radiogroups.length} named radio groups, expected 3`)
  // card 1: keep yours (Space on the first radio); card 2: take theirs (arrow); card 3: write it (arrows, Tab, type)
  const radioOf = (k) => `a.type === 'radio' && [...document.querySelectorAll('.bw-merge-card')].indexOf(a.closest('.bw-merge-card')) === ${k}`
  if (await tabTo(radioOf(0))) await press(' ')
  if (await tabTo(radioOf(1))) await press('ArrowDown')
  if (await tabTo(radioOf(2))) {
    await press('ArrowDown')
    await press('ArrowDown')
  }
  const cardOrder = await js(`return [...document.querySelectorAll('.bw-merge-card legend')].map((l) => l.textContent.slice(0, 40))`)
  const picked = await js(`return [...document.querySelectorAll('.bw-merge-card')].map((c) => [...c.querySelectorAll('input[type=radio]')].findIndex((r) => r.checked))`)
  check(JSON.stringify(picked) === '[0,1,2]', `C: radios picked ${JSON.stringify(picked)}, expected keep / take / write`)
  if (await tabTo(`a.tagName === 'TEXTAREA' && !!a.closest('.bw-merge-edit')`, 6)) {
    // Cmd+A (the editing command it maps to is passed explicitly, as headless Chrome needs), then type over it
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
    await send('Input.insertText', { text: 'Worker (A + B)' })
    await sleep(150)
  }
  if (await tabTo(`a.tagName === 'BUTTON' && a.textContent.includes('Open merged as a board') && !a.disabled`, 12)) await press('Enter')
  check(await until(`return !document.querySelector('.bw-change')`), 'C: the merged board did not open')
  await sleep(400)
  await js(`${HELPERS}
    click('.bw-topbar button[aria-haspopup="menu"]', 'Boards')
    await new Promise((r) => setTimeout(r, 150))
    click('[role=menuitem]', 'Source file of this board')
    return true`)
  await until(`return !!document.querySelector('.bw-source-text')`)
  const kb = await js(`return document.querySelector('.bw-source-text')?.value ?? ''`)
  report.keyboardLabels = (kb.match(/"label": "(Gateway|Catalog|Worker|Orders DB|Card)[^"]*"/g) ?? [])
  report.cardOrder = cardOrder
  // cards come in id order (catalog, gw, worker): keep yours, take theirs, write it
  for (const want of ['"label": "Catalog A"', '"label": "Gateway B"', '"label": "Worker (A + B)"', '"label": "Orders DB (ours)"', '"label": "Card processor (theirs)"']) check(kb.includes(want), `C: the keyboard-merged source lacks ${want}`)
  // the dialog is modal (Tab stays inside it on purpose), never a trap: Escape leaves it and focus returns to the board
  const afterOpen = await js(`return document.activeElement?.className ?? ''`)
  await palette('Review an architecture')
  const opened = await until(`return !!document.querySelector('.bw-change')`)
  await press('Escape')
  const escaped = await until(`return !document.querySelector('.bw-change') && document.activeElement?.classList.contains('bw-canvas')`)
  check(opened && escaped, 'C: Escape did not close the change review and return focus to the board')
  report.keyboardExit = { focusAfterOpeningMerge: afterOpen, escapeReturnsToCanvas: escaped }
  check(hidden.length === 0, `C: ${hidden.length} focus stop(s) without a visible indicator: ${hidden.slice(0, 6).join('; ')}`)
  check(stuck === 0, 'C: focus did not move on Tab')
  report.keyboard = { tabStops: focusTrail.length, invisibleFocus: hidden.length, namedCardGroups: groups.length, namedRadioGroups: radiogroups.length, picked }

  // ---- D. the header box is its own choice ------------------------------------------------------------------
  // A board from an import (an approximation warning, an original comment), then a re-import that adds a node
  // and brings a clean header. With the box unticked the accepted board gets the node and keeps its header;
  // ticked, the new provenance replaces the old.
  const reviewImport = async (text) => {
    await palette('Review an architecture')
    check(await until(`return !!document.querySelector('.bw-cr-foreign-text')`), 'D: the change review has no import box')
    await js(`${HELPERS}
      const ta = document.querySelector('.bw-cr-foreign-text')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 100))
      click('button', 'Review the import')
      await new Promise((r) => setTimeout(r, 200))
      click('[role=tab]', 'Accept & export')
      return true`)
    return until(`return !!document.querySelector('.bw-cr-patch')`)
  }
  // the board's source panel (a toggle that stays open across boards once opened)
  const PANEL = `.bw-source-text:not(.bw-cr-foreign-text)`
  const boardText = async () => {
    await sleep(400)
    if (!(await js(`return !!document.querySelector('${PANEL}')`))) {
      await js(`${HELPERS}
        click('.bw-topbar button[aria-haspopup="menu"]', 'Boards')
        await new Promise((r) => setTimeout(r, 150))
        click('[role=menuitem]', 'Source file of this board')
        return true`)
      await until(`return !!document.querySelector('${PANEL}')`)
    }
    return js(`return document.querySelector('${PANEL}')?.value ?? ''`)
  }
  const openAccepted = async () => {
    await js(`${HELPERS} click('button', 'Open accepted as a board'); return true`)
    return until(`return !document.querySelector('.bw-change')`)
  }
  const box = (want) => js(`
    const b = [...document.querySelectorAll('.bw-cr-check input[type=checkbox]')].find((x) => x.parentElement.textContent.includes('header comments'))
    if (!b) return null
    if (b.checked !== ${want}) b.click()
    return true`)
  const patchText = () => js(`return document.querySelector('.bw-cr-patch')?.textContent ?? ''`)
  const first = 'flowchart LR\n%% old comment\na["#1114112;"] --> b[B]\n'
  const second = 'flowchart LR\n%% new clean comment\na["\uFFFD"] --> b[B]\nb --> c[C]\n'
  const header = {}
  for (const on of [false, true]) {
    const tag = `header ${on ? 'on' : 'off'}`
    await palette('New blank board')
    check(await reviewImport(first), `D: ${tag}: the first import did not reach the patch tab`)
    check(await openAccepted(), `D: ${tag}: the first import did not open as a board`)
    const firstBoard = await boardText()
    check(firstBoard.includes('old comment') && firstBoard.includes('invalid character reference'), `D: ${tag}: the first imported board lacks its header`)
    check(await reviewImport(second), `D: ${tag}: the re-import did not reach the patch tab`)
    check(await js(`return document.querySelector('.bw-cr-patch')?.textContent.includes('"id": "c"') ?? false`), `D: ${tag}: the re-import was not compared with the board (no node c in the patch)`)
    check((await box(on)) === true, `D: ${tag}: no header checkbox on the patch tab`)
    await until(`const p = document.querySelector('.bw-cr-patch')?.textContent ?? ''; return ${on} === p.includes('new clean comment')`, 3000)
    const patch = await patchText()
    check(await openAccepted(), `D: ${tag}: the accepted re-import did not open`)
    const text = await boardText()
    const facts = { patchTakesHeader: patch.includes('+  //   line 2: new clean comment'), patchDropsOld: /^-.*old comment/m.test(patch), hasC: text.includes('"id": "c"'), oldKept: text.includes('old comment') && text.includes('invalid character reference'), newTaken: text.includes('new clean comment') }
    header[on ? 'on' : 'off'] = facts
    check(facts.hasC, `D: ${tag}: the accepted board lacks node c`)
    if (on) check(facts.patchTakesHeader && facts.patchDropsOld && facts.newTaken && !facts.oldKept, `D: header on did not take the new provenance: ${JSON.stringify(facts)}`)
    else check(!facts.patchTakesHeader && !facts.patchDropsOld && facts.oldKept && !facts.newTaken, `D: header off still changed the header: ${JSON.stringify(facts)}`)
  }
  report.header = header
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* gone */ }
} catch (err) {
  failures.push(`error: ${err.message}`)
} finally {
  ws.close()
  cleanup()
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* in use */ }
}

report.failures = failures
const text = JSON.stringify(report, null, 2)
console.log(text)
if (arg('out')) writeFileSync(arg('out'), text + '\n')
if (failures.length) {
  console.error(`FAIL: ${failures.length} check(s) failed`)
  process.exit(1)
}
process.exit(0)
