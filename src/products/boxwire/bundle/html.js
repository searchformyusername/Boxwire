// review.html: one static file that works opened from disk with the network
// off. The view model rides along as JSON in a non-executing script tag and a
// small inline script builds the page with textContent only. A CSP pinned to
// that script's hash forbids every network request and any other script. The
// two views are <img> data URLs, so SVG can't run script or load anything.

import { base64, sha256Base64 } from './digest.js'
import { summaryLines } from './view.js'

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
/** JSON safe inside a <script> element: no "</script", "<!--" or HTML-significant characters. */
const scriptJson = (v) => JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

const CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1a1d23; --muted: #4a5160; --line: #d5d9e0; --panel: #f4f6f9; --bad: #a3141b; --warn: #7a4b00; --ok: #18632f; --accent: #1f4fbf; }
@media (prefers-color-scheme: dark) { :root { --bg: #14161a; --fg: #e9ecf1; --muted: #b1b8c4; --line: #3a404b; --panel: #1d2026; --bad: #ff8a8f; --warn: #f2c063; --ok: #7fd99a; --accent: #9dbbff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; } h2 { font-size: 1.2rem; margin: 32px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
code, .hash, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.85em; }
.hash { overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 8px 0; } dt { color: var(--muted); }
.note { background: var(--panel); border-left: 4px solid var(--accent); padding: 8px 12px; margin: 12px 0; }
.views { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
figure { margin: 0; border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: var(--panel); }
figure img { display: block; width: 100%; height: auto; background: #fff; border-radius: 4px; }
figcaption { font-weight: 600; margin-bottom: 6px; }
ul { padding-left: 20px; } li { margin: 4px 0; } .detail, .src { color: var(--muted); }
.scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); padding: 6px 8px; } th { background: var(--panel); }
.status-violation, .status-fail, .status-error { color: var(--bad); font-weight: 600; } .status-unknown, .status-warning { color: var(--warn); font-weight: 600; } .status-pass, .status-ok { color: var(--ok); font-weight: 600; }
pre { white-space: pre-wrap; background: var(--panel); padding: 12px; border-radius: 6px; }
`

// Runs in the reviewer's browser. Builds DOM from the JSON with textContent; never parses data as HTML.
const SCRIPT = `
(function () {
  var d = JSON.parse(document.getElementById('data').textContent)
  var app = document.getElementById('app')
  function h(tag, text, cls) {
    var n = document.createElement(tag)
    if (text !== undefined && text !== null) n.textContent = String(text)
    if (cls) n.className = cls
    return n
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i])
    return parent
  }
  function section(title, count) {
    var s = h('section')
    s.setAttribute('aria-labelledby', 'h-' + title.replace(/\\W+/g, '-'))
    var head = h('h2', title + ' (' + count + ')')
    head.id = 'h-' + title.replace(/\\W+/g, '-')
    app.appendChild(add(s, head))
    return s
  }
  function src(ranges) {
    return ranges && ranges.length ? h('div', 'Source: ' + ranges.join(', '), 'src') : null
  }
  function more(s, n) {
    if (n) s.appendChild(h('p', '… and ' + n + ' more (see results.json).'))
  }

  var meta = h('dl')
  var rows = [['Created', d.createdAt], ['Tool', d.tool], ['Baseline SHA-256', d.baselineHash], ['Proposal SHA-256', d.proposalHash]]
  if (d.acceptedHash) rows.push(['Accepted SHA-256', d.acceptedHash])
  rows.forEach(function (r) { add(meta, h('dt', r[0]), h('dd', r[1], /SHA/.test(r[0]) ? 'hash' : '')) })
  add(document.getElementById('meta'), meta, h('p', d.note, 'note'), ...(d.comparison ? [h('p', d.comparison, 'note')] : []))

  function changes(title, block) {
    var s = section(title, block.items.length + block.more)
    if (!block.items.length) return s.appendChild(h('p', 'None.'))
    var ul = h('ul')
    block.items.forEach(function (it) {
      add(ul, add(h('li'), h('span', it.text), it.detail ? h('div', it.detail, 'detail') : null, src(it.ranges)))
    })
    s.appendChild(ul)
    more(s, block.more)
  }
  changes('Semantic changes', d.semantic)
  changes('Layout changes', d.layout)
  if (d.identity && (d.identity.items.length || d.identity.more)) changes('Identity changes (connector ids written down)', d.identity)

  var rs = section('Rule results', d.rules.items.length + d.rules.more)
  if (!d.rules.items.length) rs.appendChild(h('p', 'None.'))
  else {
    var table = h('table')
    add(table, h('caption', 'Each declared rule, its status, the witness path and the source ranges it points at.'))
    var hr = h('tr')
    ;['Status', 'Rule', 'Result', 'Witness', 'Source'].forEach(function (c) {
      var th = h('th', c)
      th.scope = 'col'
      hr.appendChild(th)
    })
    add(table, add(h('thead'), hr))
    var body = h('tbody')
    d.rules.items.forEach(function (it) {
      var tr = h('tr')
      add(tr, h('td', it.status || '—', 'status-' + String(it.status).toLowerCase().replace(/\\W+/g, '')), h('td', it.rule || '—'),
        add(h('td', it.text), it.detail ? h('div', it.detail, 'detail') : null), h('td', it.witness || '—'), h('td', it.ranges.join(', ') || '—', 'src'))
      body.appendChild(tr)
    })
    rs.appendChild(add(h('div', null, 'scroll'), add(table, body)))
    more(rs, d.rules.more)
  }
  changes('Conflicts', d.conflicts)

  var fs = section('Files', d.files.length)
  var ft = h('table')
  var fh = h('tr')
  ;['Path', 'Bytes', 'SHA-256'].forEach(function (c) {
    var th = h('th', c)
    th.scope = 'col'
    fh.appendChild(th)
  })
  add(ft, add(h('thead'), fh))
  var fb = h('tbody')
  d.files.forEach(function (f) { add(fb, add(h('tr'), h('td', f.path), h('td', f.bytes), h('td', f.sha256, 'hash'))) })
  fs.appendChild(add(h('div', null, 'scroll'), add(ft, fb)))
})()
`

/**
 * The self-contained review page. `view` comes from reviewView(); `svgs` maps
 * 'baseline' | 'proposal' to SVG strings (either may be missing).
 */
export async function reviewHtml(view, svgs = {}) {
  const scriptHash = await sha256Base64(SCRIPT)
  const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'`
  const figure = (key, label) => svgs[key]
    ? `<figure><figcaption>${label}</figcaption><img alt="${label} diagram, rendered from ${key}.boxwire.jsonc" src="data:image/svg+xml;base64,${base64(svgs[key])}"></figure>`
    : `<figure><figcaption>${label}</figcaption><p>No rendered view was included.</p></figure>`
  const views = svgs.baseline || svgs.proposal
    ? `<section aria-labelledby="h-views"><h2 id="h-views">Views</h2><div class="views">${figure('baseline', 'Baseline')}${figure('proposal', 'Proposal')}</div></section>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(view.name)} · Boxwire review</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(view.name)}</h1>
<p>Architecture change review exported from Boxwire. This page is static: it makes no network requests.</p>
<noscript><pre>${esc(summaryLines(view).join('\n'))}</pre></noscript>
<div id="meta"></div>
${views}
<div id="app"></div>
</main>
<script type="application/json" id="data">${scriptJson(view)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`
}
