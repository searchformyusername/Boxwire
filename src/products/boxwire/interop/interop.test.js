// Mermaid flowchart and Structurizr DSL subset import: what comes across, what is reported as lost
// (with its line), and that the result lands as an ordinary reviewable change.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectFormat, emptyBaseline, hasImportHeader, importForeign } from './index.js'
import { codePoint } from './mermaid.js'
import { lossReport } from './report.js'
import { compileDiagram } from '../author/compile.js'
import { STUB_MEASURE } from '../change/model.js'
import { acceptedPatchFile, bundledSelection, recomputeFromBundle, rejectedFromSelection, reviewSources, takesHeader } from '../change/handoff.js'
import { buildReviewBundle, openReviewBundle } from '../bundle/bundle.js'
import { allChanges, diffModels } from '../change/diff.js'
import { parseSource } from '../source/cst.js'

const read = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')
const lossAt = (r, construct) => r.losses.find((l) => l.construct === construct)?.lines ?? null
const mermaid = (body) => importForeign(`flowchart LR\n${body}\n`)

describe('Mermaid flowchart subset', () => {
  const r = importForeign(read('checkout.mmd'))

  it('imports nodes, shapes, links, labels, chains, & groups and subgraphs', () => {
    expect(r.errors).toEqual([])
    expect(r.value.name).toBe('Checkout flow')
    expect(r.value.direction).toBe('LR')
    expect(r.value.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['user', 'ellipse'], ['web', 'box'], ['api', 'hexagon'], ['cart', 'box'], ['orders', 'box'], ['bus', 'cylinder'],
      ['mailer', 'box'], ['db', 'cylinder'], ['cache', 'cylinder'], ['auth', 'box'], ['auth2', 'box'],
    ])
    const e = (from, to) => r.value.edges.find((x) => x.from === from && x.to === to)
    expect(e('user', 'web')).toEqual({ from: 'user', to: 'web', label: 'browse' })
    expect(e('api', 'cart')).toBeTruthy() // a & b
    expect(e('api', 'orders')).toBeTruthy()
    expect(e('orders', 'bus')).toEqual({ from: 'orders', to: 'bus', kind: 'async', label: 'order placed' })
    expect(e('orders', 'db')).toEqual({ from: 'orders', to: 'db', width: 3 })
    expect(e('cart', 'cache').label).toBe('reads and writes') // -- text -->
    expect(e('api', 'auth').kind).toBe('line')
    expect(r.value.zones).toEqual([
      { id: 'core', label: 'Core services', contains: ['cart', 'orders'] },
      { id: 'data', label: 'Data', contains: ['db'] },
      { id: 'hot', label: 'Hot data', contains: ['cache'] },
    ])
  })

  it('lists every construct it did not carry over, with its line', () => {
    expect(lossAt(r, 'click')).toEqual([24])
    expect(lossAt(r, 'classDef')).toEqual([25])
    expect(lossAt(r, 'class')).toEqual([26])
    expect(lossAt(r, 'style')).toEqual([27])
    expect(lossAt(r, 'linkStyle')).toEqual([28])
    expect(lossAt(r, ':::class on a node')).toEqual([29])
    expect(lossAt(r, 'invisible link (~~~)')).toEqual([30])
    expect(lossAt(r, 'self-loop')).toEqual([31])
    expect(lossAt(r, 'edge id (e1@-->)')).toEqual([32])
    expect(lossAt(r, 'nested subgraph')).toEqual([20])
    expect(lossAt(r, 'cross head (--x)')).toEqual([29])
    expect(r.losses.filter((l) => l.construct === 'node shape').flatMap((l) => l.lines).sort((a, b) => a - b)).toEqual([6, 8, 10, 13])
    expect(r.losses.some((l) => l.construct === 'statement')).toBe(false) // every line in the fixture was understood
  })

  it('writes the loss report and the original comments into the generated source header', () => {
    for (const l of r.losses) expect(r.source).toContain(`${l.kind}: ${l.construct}`)
    expect(r.source).toContain('//   line 4:  A Mermaid flowchart that exercises the supported subset'.replace('  A', ' A'))
    expect(parseSource(r.source).value).toEqual(r.value)
  })

  it('never drops a statement silently: anything not understood is listed with its line', () => {
    const x = mermaid('  a --> b\n  this is not mermaid ((\n  b --> c')
    expect(x.value.edges).toHaveLength(2)
    expect(lossAt(x, 'statement')).toEqual([3])
  })

  it('reads the documented link and shape forms', () => {
    const forms = ['A --> B', 'A --- B', 'A -.-> B', 'A ==> B', 'A --o B', 'A <--> B', 'A -->|text| B', 'A -- text --> B', 'A -. text .-> B', 'A == text ==> B', 'A ---> B', 'A --> B --> C', 'A & B --> C']
    for (const f of forms) {
      const x = mermaid(f)
      expect(x.errors, f).toEqual([])
      expect(x.losses.filter((l) => l.construct === 'statement'), f).toEqual([])
      expect(x.value.edges.length, f).toBeGreaterThan(0)
    }
    const shapes = ['A[rect]', 'A(round)', 'A([stadium])', 'A[[sub]]', 'A[(db)]', 'A((circle))', 'A>flag]', 'A{rhombus}', 'A{{hex}}', 'A[/para/]', 'A[\\para\\]', 'A[/trap\\]', 'A[\\trap/]', 'A(((double)))', 'A["quoted (with) brackets"]']
    for (const s of shapes) {
      const x = mermaid(`${s} --> B`)
      expect(x.losses.filter((l) => l.construct === 'statement'), s).toEqual([])
      expect(x.value.nodes[0].label, s).not.toMatch(/^[[({>/\\]/)
    }
    expect(mermaid('A["say #quot;hi#quot;<br/>twice"] --> B').value.nodes[0].label).toBe('say "hi"\ntwice')
  })

  it('refuses other Mermaid diagram types and unrecognised text, with a line', () => {
    expect(importForeign('sequenceDiagram\n  A->>B: hi').errors[0].message).toMatch(/sequenceDiagram is not supported/)
    expect(importForeign('hello').errors[0].message).toMatch(/Not recognised/)
    expect(detectFormat('%% c\nflowchart TD')).toBe('mermaid')
  })

  it('lands as a reviewable change: against an empty baseline every element is an addition, and accepting all reproduces it', () => {
    const rv = reviewSources({ baseline: emptyBaseline('x'), proposal: r.source, accept: { all: true, except: [] } })
    expect(rv.review.comparison).toEqual({ status: 'complete' })
    expect(rv.review.diff.semantic.filter((c) => c.type === 'add')).toHaveLength(r.value.nodes.length + r.value.edges.length + r.value.zones.length)
    expect(rv.accepted.valid).toBe(true)
    expect(rv.accepted.unsupported).toEqual([])
    const back = diffModels(parseSource(rv.accepted.source).value, r.value)
    expect(allChanges(back)).toEqual([])
  })

  it('re-importing an edited flowchart reviews as exactly what changed, by stable id', () => {
    const v1 = importForeign('flowchart LR\n  web[Web] --> api[API]\n  api --> db[(DB)]\n')
    const v2 = importForeign('flowchart LR\n  web[Web app] --> api[API]\n  api --> db[(DB)]\n  api --> cache[(Cache)]\n')
    const rv = reviewSources({ baseline: v1.source, proposal: v2.source })
    expect(rv.review.diff.semantic.map((c) => c.id)).toEqual(['node:cache', 'node:web:label', 'edge:api->cache:flow'])
  })
})

describe('Structurizr DSL subset', () => {
  const r = importForeign(read('bigbank-like.dsl'))
  const kinds = (k) => r.value.nodes.filter((n) => n.kind === k).length
  const frame = (id) => r.value.frames.find((f) => f.id === id)

  it('imports every model element, with counts preserved', () => {
    expect(r.errors).toEqual([])
    expect(r.value.name).toBe('Retail Bank')
    expect(kinds('user')).toBe(3) // people
    // 4 software systems: 3 leaf systems as nodes, Internet Banking as the zone around its containers
    expect(r.value.nodes.filter((n) => n.kind === 'service' && !n.label.includes('[Component:')).map((n) => n.id)).toEqual(['mainframe', 'email', 'atm'])
    expect(r.value.zones.map((z) => z.id)).toEqual(['internetBankingSystem', 'apiApplication'])
    // 5 containers: 4 as nodes, API Application as the zone around its 6 components
    expect(r.value.nodes.filter((n) => n.label.includes('[Container:'))).toHaveLength(4)
    expect(r.value.nodes.filter((n) => n.label.includes('[Component:'))).toHaveLength(6)
    expect(r.value.zones[1].contains).toHaveLength(6)
    expect(r.value.edges).toHaveLength(26) // every declared relationship
    expect(kinds('sql-database')).toBe(1)
    expect(kinds('web-client')).toBe(1)
    expect(kinds('mobile-app')).toBe(1)
  })

  it('keeps the Context and Container views as frames with their element counts', () => {
    expect(frame('SystemContext').contains.sort()).toEqual(['customer', 'email', 'internetBankingSystem', 'mainframe'])
    expect(frame('Containers').contains).toHaveLength(8) // 5 containers + customer, mainframe, e-mail
    expect(frame('Containers').contains).toEqual(expect.arrayContaining(['singlePageApplication', 'mobileApp', 'webApplication', 'apiApplication', 'database']))
    expect(frame('SystemLandscape').contains).toHaveLength(7) // 3 people + 4 systems
  })

  it('lists deployment, dynamic, styles, themes and animation as not imported, with their lines', () => {
    expect(lossAt(r, 'deploymentEnvironment')).toEqual([70, 77])
    expect(lossAt(r, 'dynamic')).toEqual([106])
    expect(lossAt(r, 'deployment')).toEqual([110])
    expect(lossAt(r, 'styles')).toEqual([114])
    expect(lossAt(r, 'theme')).toEqual([122])
    expect(lossAt(r, 'animation')).toEqual([91])
    expect(lossAt(r, 'group')).toEqual([14])
    expect(lossAt(r, 'nested boundary')).toEqual([22])
  })

  it('resolves hierarchical identifiers and in-block relationships', () => {
    const x = importForeign('workspace "W" {\n  !identifiers hierarchical\n  model {\n    u = person "User"\n    s = softwareSystem "Shop" {\n      web = container "Web" {\n        -> s.db "Reads"\n      }\n      db = container "DB" "" "Postgres" "Database"\n    }\n    u -> s.web "Uses"\n  }\n}\n')
    expect(x.errors).toEqual([])
    expect(x.value.edges).toEqual([{ from: 's-web', to: 's-db', label: 'Reads' }, { from: 'u', to: 's-web', label: 'Uses' }])
    expect(x.value.nodes.find((n) => n.id === 's-db').kind).toBe('sql-database')
  })

  it('reports an unclosed block instead of accepting it silently', () => {
    const x = importForeign('workspace {\n model {\n a = person "A"\n')
    expect(x.errors).toEqual([])
    expect(lossAt(x, 'unclosed block')).toEqual([1, 2])
  })

  it('reports an unknown identifier instead of inventing an element', () => {
    const x = importForeign('workspace {\n  model {\n    a = person "A"\n    a -> b "?"\n  }\n}\n')
    expect(lossAt(x, 'relationship to an unknown identifier')).toEqual([4])
    expect(x.value.edges).toEqual([])
  })

  it('lands as a reviewable change whose accepted source reproduces it', () => {
    const rv = reviewSources({ baseline: emptyBaseline('x'), proposal: r.source, accept: { all: true, except: [] } })
    expect(rv.review.comparison).toEqual({ status: 'complete' })
    expect(rv.accepted.valid).toBe(true)
    expect(allChanges(diffModels(parseSource(rv.accepted.source).value, r.value))).toEqual([])
  })
})

describe('importers never throw (reviewer P2: #1114112; raised a RangeError)', () => {
  it('numeric entities: valid ones decode; out of range, surrogates, NUL and huge numbers become U+FFFD with a loss entry', () => {
    const ok = importForeign('flowchart LR\na["#128578;"] --> b[DB]\n')
    expect(ok.value.nodes[0].label).toBe('🙂')
    for (const n of ['1114112', '55296', '57343', '0', '99999999999999999999999']) {
      const r = importForeign(`flowchart LR\na["x #${n}; y"] --> b[DB]\n`)
      expect(r.errors, n).toEqual([])
      expect(r.value.nodes[0].label, n).toBe('x \uFFFD y')
      expect(lossAt(r, 'invalid character reference'), n).toEqual([2])
    }
    const rep = lossReport()
    for (const n of [-1, 0, 0xd800, 0xdfff, 0x110000, Infinity, NaN, 2 ** 53]) expect(codePoint(n, rep, 1)).toBe('\uFFFD')
    expect(codePoint(0x10ffff, rep, 1)).toBe(String.fromCodePoint(0x10ffff))
    expect(codePoint(0xe000, rep, 1)).toBe('\ue000')
  })

  // a deterministic fuzzer: fragments of each language, random and boundary code points, entities and junk
  function rng(seed) {
    let x = seed >>> 0
    return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  }
  const BOUNDARY = [0, 1, 0x1f, 0x7f, 0xa0, 0xad, 0x2028, 0x2029, 0x202e, 0xd7ff, 0xe000, 0xfeff, 0xfffd, 0xffff, 0x10000, 0x1f642, 0x10ffff]
  const char = (rnd) => {
    const r = rnd()
    if (r < 0.3) return String.fromCodePoint(BOUNDARY[Math.floor(rnd() * BOUNDARY.length)])
    if (r < 0.4) return String.fromCharCode(0xd800 + Math.floor(rnd() * 0x800)) // a lone surrogate
    if (r < 0.5) return `#${[0, 55296, 57343, 1114111, 1114112, 4294967296, Math.floor(rnd() * 2e6)][Math.floor(rnd() * 7)]};`
    if (r < 0.6) return String.fromCodePoint(Math.floor(rnd() * 0x10ffff) % 0xd800)
    return 'abcxyz09 _-[](){}<>|"\'/\\:;&.=#%@*~'[Math.floor(rnd() * 30)]
  }
  const junk = (rnd, n) => Array.from({ length: n }, () => char(rnd)).join('')
  const MERMAID = ['a --> b', 'a[{x}] --> b', 'a(({x}))', 'a -->|{x}| b', 'a -- {x} --> b', 'a -.-> b{{{x}}}', 'subgraph s [{x}]', 'end', 'a & b --> c', 'a ==> b[({x})]', 'click a "{x}"', 'classDef c {x}', 'a@{ shape: {x} }', 'a e1@--> b', '{x}', 'a["{x}"] --> b']
  const DSL = ['a = person "{x}"', 's = softwareSystem "{x}" {', 'c = container "{x}" "{x}" "{x}" "Database"', '}', 'a -> s "{x}"', '-> c "{x}"', 'group "{x}" {', '!identifiers hierarchical', 'views {', 'systemContext s "{x}" {', 'include *', 'autoLayout {x}', 'styles {', '{x}', '"{x}', '/* {x} */', '# {x}']

  it('500 random Mermaid flowcharts: a result or a refusal, never an exception, and any result compiles', () => {
    const rnd = rng(7)
    let produced = 0
    for (let i = 0; i < 500; i++) {
      const lines = ['flowchart ' + ['LR', 'TD', 'RL', 'XX', ''][Math.floor(rnd() * 5)]]
      for (let k = 0; k < 1 + Math.floor(rnd() * 12); k++) lines.push('  ' + MERMAID[Math.floor(rnd() * MERMAID.length)].replace(/\{x\}/g, () => junk(rnd, Math.floor(rnd() * 12))))
      const text = lines.join(rnd() < 0.2 ? '\r\n' : '\n')
      let r
      expect(() => (r = importForeign(text)), text).not.toThrow()
      if (r.value) {
        produced++
        expect(compileDiagram(r.value, { measure: STUB_MEASURE }).errors, text).toEqual([])
      } else {
        expect(r.errors.length, text).toBeGreaterThan(0)
        expect(r.errors.map((e) => e.message).join(' '), text).not.toMatch(/^internal:/) // a refusal is about the input, never our bug
      }
    }
    expect(produced).toBeGreaterThan(80) // the fuzzer reaches the mapping, not just the refusals
  })

  it('500 random Structurizr workspaces: a result or a refusal, never an exception, and any result compiles', () => {
    const rnd = rng(11)
    let produced = 0
    for (let i = 0; i < 500; i++) {
      const lines = ['workspace "' + junk(rnd, 6) + '" {', 'model {']
      for (let k = 0; k < 1 + Math.floor(rnd() * 14); k++) lines.push('  ' + DSL[Math.floor(rnd() * DSL.length)].replace(/\{x\}/g, () => junk(rnd, Math.floor(rnd() * 10))))
      lines.push('}', '}')
      const text = lines.join('\n')
      let r
      expect(() => (r = importForeign(text)), text).not.toThrow()
      if (r.value) {
        produced++
        expect(compileDiagram(r.value, { measure: STUB_MEASURE }).errors, text).toEqual([])
      } else {
        expect(r.errors.length, text).toBeGreaterThan(0)
        expect(r.errors.map((e) => e.message).join(' '), text).not.toMatch(/^internal:/) // a refusal is about the input, never our bug
      }
    }
    expect(produced).toBeGreaterThan(80) // the fuzzer reaches the mapping, not just the refusals
  })

  it('plain junk in either language is refused with a line, never thrown', () => {
    const rnd = rng(13)
    for (let i = 0; i < 300; i++) {
      const text = (i % 2 ? 'flowchart LR\n' : 'workspace {\n') + junk(rnd, 80)
      expect(() => importForeign(text)).not.toThrow()
    }
  })
})

describe('accepted sources keep provenance, warnings and comments (reviewer P2 on ae348a5)', () => {
  const text = 'flowchart LR\n%% original note\na["x #1114112; y"] --> b[DB]\nb --> c[Cache]\n'
  const r = importForeign(text)
  const head = (src) => src.split('\n').filter((l) => l.trim().startsWith('//')).map((l) => l.trim())

  it('accept all: the import header, its warnings and the original comments are in the accepted source', () => {
    const rv = reviewSources({ baseline: emptyBaseline('x'), proposal: r.source, accept: { all: true, except: [] } })
    expect(head(rv.accepted.source)).toEqual(head(r.source))
    expect(rv.accepted.source).toContain('invalid character reference')
    expect(rv.accepted.source).toContain('//   line 2:  original note'.replace('  original', ' original'))
    expect(parseSource(rv.accepted.source).value.nodes).toEqual(r.value.nodes)
  })

  it('partial accept keeps the header too (it describes where the accepted part came from)', () => {
    const ids = allChanges(reviewSources({ baseline: emptyBaseline('x'), proposal: r.source }).review.diff).map((c) => c.id)
    const rv = reviewSources({ baseline: emptyBaseline('x'), proposal: r.source, accept: { all: true, except: ids.filter((id) => id.startsWith('node:c') || id.includes('->c')) } })
    expect(rv.accepted.valid).toBe(true)
    expect(head(rv.accepted.source)).toEqual(head(r.source))
    expect(parseSource(rv.accepted.source).value.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('re-import: the new import header replaces the old one; hand-written comments stay', () => {
    const first = reviewSources({ baseline: emptyBaseline('x'), proposal: r.source, accept: { all: true, except: [] } }).accepted.source
    const mine = first.replace('{\n', '{\n  // reviewed by the platform team\n')
    const r2 = importForeign(text.replace('b --> c[Cache]', 'b --> c[Cache]\nc --> d[Store]'))
    const rv = reviewSources({ baseline: mine, proposal: r2.source, accept: { all: true, except: [] } })
    const h = head(rv.accepted.source)
    expect(h).toContain('// reviewed by the platform team')
    expect(h.filter((l) => l.startsWith('// Imported from'))).toEqual(['// Imported from a Mermaid flowchart (5 lines) by Boxwire.'])
    expect(h.filter((l) => /Imported from a Mermaid flowchart \(4 lines\)/.test(l))).toEqual([])
  })

  it('in general: an added item brings its own comments, inline arrays get block comments, and an empty accept changes nothing', () => {
    const base = '{\n  "format": "boxwire-diagram",\n  "version": 1,\n  "nodes": [\n    { "id": "a", "kind": "service" }\n  ],\n  "edges": [{ "from": "a", "to": "a2" }]\n}\n'
    const fixed = base.replace('"edges": [{ "from": "a", "to": "a2" }]', '"edges": []')
    const prop = fixed.replace('{ "id": "a", "kind": "service" }', '{ "id": "a", "kind": "service" },\n    // the read replica, added for reporting\n    { "id": "b", "kind": "sql-database" } // eventually consistent').replace('"edges": []', '"edges": [{ "from": "a", "to": "b" } /* reporting */]')
    const rv = reviewSources({ baseline: fixed, proposal: prop, accept: { all: true, except: [] } })
    expect(rv.accepted.valid).toBe(true)
    expect(rv.accepted.source).toContain('    // the read replica, added for reporting\n    // eventually consistent\n    { "id": "b", "kind": "sql-database" }')
    expect(rv.accepted.source).toContain('/* reporting */ { "from": "a", "to": "b" }')
    expect(parseSource(rv.accepted.source).value).toEqual(parseSource(prop).value)
    expect(reviewSources({ baseline: fixed, proposal: prop, accept: [] }).accepted.source).toBe(fixed)
  })
})

describe('metadata-only re-import and import detection (reviewer P2s on f95084c)', () => {
  const first = importForeign('flowchart LR\n%% old original note\na["#1114112;"] --> b[DB]\nb --> c[Cache]\n')
  const board = reviewSources({ baseline: emptyBaseline('x'), proposal: first.source, accept: { all: true, except: [] } }).accepted.source

  it('a re-import with no model change still replaces the provenance header, its warnings and its comments', () => {
    const second = importForeign('flowchart LR\n%% current valid original note\na["\uFFFD"] --> b[DB]\nb --> c[Cache]\n')
    const rv = reviewSources({ baseline: board, proposal: second.source, accept: { all: true, except: [] } })
    expect(allChanges(rv.review.diff).filter((c) => c.class === 'semantic')).toEqual([])
    expect(rv.accepted.source).not.toContain('invalid character reference')
    expect(rv.accepted.source).not.toContain('old original note')
    expect(rv.accepted.source).toContain('//   line 2: current valid original note')
    expect(rv.accepted.source).toContain('// Everything in it was carried over')
    // the dialog's two ways to tick nothing: with the header (every model change excepted, applied is empty,
    // and the provenance still updates), or keeping the header (an empty list: the source byte for byte)
    const ids = allChanges(reviewSources({ baseline: board, proposal: second.source }).review.diff).map((c) => c.id)
    const headerOnly = reviewSources({ baseline: board, proposal: second.source, accept: { all: true, except: ids } })
    expect(headerOnly.accepted.applied).toEqual([])
    expect(headerOnly.accepted.source).not.toBe(board)
    expect(headerOnly.accepted.source).toContain('current valid original note')
    expect(reviewSources({ baseline: board, proposal: second.source, accept: [] }).accepted.source).toBe(board)
  })

  it('detects an import header wherever it sits among the leading comments', () => {
    expect(hasImportHeader(board)).toBe(true)
    expect(hasImportHeader(board.replace('{\n', '{\n  // reviewed by the platform team\n  /* and kept in git */\n'))).toBe(true)
    expect(hasImportHeader(emptyBaseline('x'))).toBe(false)
    expect(hasImportHeader('{ "format": "boxwire-diagram", "version": 1, "nodes": [], "name": "// Imported from a Mermaid flowchart (2 lines)" }')).toBe(false)
    expect(hasImportHeader('not json')).toBe(false)
  })
})


describe('the header box is independent of the ticked model changes (reviewer P2 on c3b2d50)', () => {
  // a board from an earlier import (warning, old original comment) plus a hand-written note
  const first = importForeign('flowchart LR\n%% old comment\na["#1114112;"] --> b[B]\n')
  const imported = reviewSources({ baseline: emptyBaseline('x'), proposal: first.source, accept: { all: true, except: [] } }).accepted.source
  const board = imported.replace('{\n', '{\n  // reviewed by the platform team\n')
  // the re-import: a clean header with a new original comment, and node c with an edge to it
  const second = importForeign('flowchart LR\n%% new clean comment\na["\uFFFD"] --> b[B]\nb --> c[C]\n').source
  // a re-import that changes only the header (no model change at all)
  const metaOnly = importForeign('flowchart LR\n%% new clean comment\na["\uFFFD"] --> b[B]\n').source
  const head = (src) => src.slice(0, src.indexOf('"format"')).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('//'))
  const idsOf = (proposal) => allChanges(reviewSources({ baseline: board, proposal }).review.diff).map((c) => c.id)
  const ids = idsOf(second)
  const sets = {
    zero: { proposal: second, except: ids, nodes: ['a', 'b'], edges: 1 },
    some: { proposal: second, except: ids.filter((id) => id.startsWith('edge:')), nodes: ['a', 'b', 'c'], edges: 1 },
    all: { proposal: second, except: [], nodes: ['a', 'b', 'c'], edges: 2 },
    'no model change in the proposal': { proposal: metaOnly, except: [], nodes: ['a', 'b'], edges: 1 },
  }

  it('the fixture has model changes to tick (a node and an edge) and a header that differs', () => {
    expect(ids.sort()).toEqual(['edge:b->c:flow', 'node:c'])
    expect(idsOf(metaOnly).filter((id) => !id.startsWith('layout') && !id.startsWith('presentation'))).toEqual(idsOf(metaOnly))
    expect(head(second)).not.toEqual(head(board))
  })

  for (const [name, c] of Object.entries(sets)) {
    for (const header of [true, false]) {
      it(`header ${header ? 'on' : 'off'} × ${name} changes: writer, bundle, reopen and recompute agree`, async () => {
        const selection = { all: true, except: c.except, header }
        const rv = reviewSources({ baseline: board, proposal: c.proposal, accept: selection })
        const out = rv.accepted
        expect(out.valid).toBe(true)
        expect(out.header).toBe(header)
        const value = parseSource(out.source).value
        expect(value.nodes.map((n) => n.id)).toEqual(c.nodes)
        expect(value.edges.length).toBe(c.edges)
        // the hand-written note stays either way
        expect(head(out.source)).toContain('// reviewed by the platform team')
        if (header) {
          // the new provenance replaces the old: no stale warning or old comment
          expect(out.source).toContain('//   line 2: new clean comment')
          expect(out.source).not.toContain('old comment')
          expect(out.source).not.toContain('invalid character reference')
        } else {
          // the board's own header comments, line for line: the old provenance and its warning are kept
          expect(head(out.source)).toEqual(head(board))
          expect(out.source).not.toContain('new clean comment')
          if (out.applied.length === 0) expect(out.source).toBe(board)
        }

        // bundle: the selection (with its header flag) is stored, and the bundle recomputes to itself
        const built = await buildReviewBundle({ name: 'header case', baseline: { source: board }, proposal: { source: c.proposal }, accepted: { source: out.source, patch: acceptedPatchFile(selection, out.patch) }, results: rv.results, createdAt: '2026-10-29T00:00:00.000Z' })
        expect(built.ok).toBe(true)
        const opened = await openReviewBundle(built.bytes, { recompute: recomputeFromBundle })
        expect(opened.errors).toEqual([])
        expect(opened.mismatches).toEqual([])
        // reopen, as the dialog does: the stored selection gives back the same boxes and the same bytes
        const stored = bundledSelection(opened.sources.acceptedPatch)
        expect(stored).toEqual(selection)
        const again = reviewSources({ baseline: opened.sources.baseline, proposal: opened.sources.proposal, accept: stored })
        expect(again.accepted.header).toBe(header)
        expect(again.accepted.source).toBe(opened.sources.accepted)
        const reIds = allChanges(again.review.diff).map((x) => x.id)
        expect([...rejectedFromSelection(stored, reIds).rejected].sort()).toEqual([...c.except].sort())

        // the flag decides the bytes, so a bundle whose stored flag was flipped no longer recomputes to its accepted source
        const flipped = { ...selection, header: !header }
        expect(reviewSources({ baseline: board, proposal: c.proposal, accept: flipped }).accepted.source).not.toBe(out.source)
        const fresh = recomputeFromBundle({ ...opened.sources, acceptedPatch: JSON.stringify(acceptedPatchFile(flipped, out.patch)) })
        expect(fresh.accepted.sourceChecksum).toMatch(/^bundled accepted source differs/)
      })
    }
  }

  it('the defaults: the dialog starts with the box ticked, and zero-model header-on still takes the new provenance', () => {
    const rv = reviewSources({ baseline: board, proposal: metaOnly, accept: { all: true, except: [], header: true } })
    expect(rv.accepted.applied).toEqual([])
    expect(rv.accepted.source).not.toBe(board)
    expect(rv.accepted.source).toContain('//   line 2: new clean comment')
  })

  it('selections written before the flag keep the rule they were written under, so old bundles recompute the same', () => {
    expect(takesHeader({ all: true, except: [] }, 0)).toBe(true)
    expect(takesHeader([], 0)).toBe(false)
    expect(takesHeader(['node:c'], 1)).toBe(true)
    expect(takesHeader({ all: true, except: [], header: false }, 2)).toBe(false)
    expect(takesHeader(['node:c'], 1)).toBe(true)
    expect(takesHeader({ all: true, header: 'no' }, 0)).toBe(true) // only a boolean counts
    const legacy = reviewSources({ baseline: board, proposal: second, accept: ['node:c'] }).accepted
    expect(legacy.header).toBe(true)
    expect(legacy.source).toContain('new clean comment')
    expect(reviewSources({ baseline: board, proposal: second, accept: [] }).accepted.source).toBe(board)
  })
})
