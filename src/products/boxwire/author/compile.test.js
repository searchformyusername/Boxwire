import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { assignIds, compileDiagram } from './compile.js'
import { layeredLayout } from './layout.js'
import { buildSchema } from './schema.js'
import Ajv2020 from 'ajv/dist/2020.js'
import { COLORS, DASHES, FILLS, HEADS, ICONS, KEYS, NODE_KINDS, RELATIONS, ROUTES, SIDES, TEXT_SIZES, TRUST_LEVELS } from './vocabulary.js'
import { createDocStore, fold } from '../core/history.js'
import { createReplay } from '../core/replay.js'
import { elementProblem, parseBoardFile, validateBoard } from '../core/validate.js'
import { createRouter, routingObstacles } from '../core/edges.js'
import { crossesRect } from '../core/route.js'
import { edgeLabelBox } from '../render/draw.js'

const measure = (s, font) => s.length * (parseFloat(/(\d+)px/.exec(font)?.[1] ?? 16) * 0.55)
const compile = (src) => compileDiagram(typeof src === 'string' ? JSON.parse(src) : src, { measure })
const EXAMPLES = new URL('../../../../public/products/boxwire/examples/', import.meta.url)
const examples = readdirSync(EXAMPLES).filter((f) => f.endsWith('.json')).map((f) => [f, readFileSync(new URL(f, EXAMPLES), 'utf8')])
const base = (extra = {}) => ({ format: 'boxwire-diagram', version: 1, nodes: [{ id: 'a', kind: 'service' }, { id: 'b', kind: 'sql-database' }], edges: [{ from: 'a', to: 'b' }], ...extra })
const paths = (r) => r.errors.map((e) => e.path)
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('public examples', () => {
  it('are all present', () => expect(examples.length).toBeGreaterThanOrEqual(4))

  for (const [file, text] of examples) {
    describe(file, () => {
      const r = compile(text)
      it('compile with no errors or warnings', () => {
        expect(r.errors).toEqual([])
        expect(r.warnings).toEqual([])
      })
      it('produce a board that validates and folds to the same document', () => {
        expect(validateBoard({ ...r.board, doc: r.doc }).warning).toBeNull()
        expect(fold(r.board.base, r.board.done)).toEqual(r.doc)
      })
      it('round-trip through a board file and reload unchanged', () => {
        const file = JSON.stringify({ format: 'boxwire', version: 1, name: r.name, board: { ...r.board, doc: r.doc } })
        const parsed = parseBoardFile(file)
        expect(parsed.error).toBeUndefined()
        expect(createDocStore(parsed.board).doc).toEqual(r.doc)
      })
      it('replay element by element and end on the imported document', () => {
        const replay = createReplay(r.board.base, r.board.done)
        expect(replay.frame(replay.total).doc).toEqual(r.doc)
        expect(replay.steps.length).toBeGreaterThan(2)
      })
      it('compile deterministically', () => expect(compile(text)).toEqual(r))
      it('lay out without overlapping nodes', () => {
        const boxes = Object.values(r.doc).filter((e) => e.type === 'node' && e.shape !== 'zone' && e.shape !== 'frame')
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(intersects(boxes[i], boxes[j]), `${boxes[i].id} overlaps ${boxes[j].id}`).toBe(false)
      })
    })
  }

  it('keep every connector label clear of the boxes (with this suite\'s approximate text metrics)', () => {
    const hits = []
    for (const [file, text] of examples) {
      const { doc } = compile(text)
      const nodes = Object.values(doc).filter((e) => e.type === 'node' && e.shape !== 'zone' && e.shape !== 'frame')
      const routes = createRouter()(doc, routingObstacles(nodes))
      for (const e of Object.values(doc).filter((x) => x.type === 'edge' && x.text)) {
        const box = edgeLabelBox(e, routes.get(e.id), measure)
        for (const n of nodes) if (intersects(box, n)) hits.push(`${file}: "${e.text}" covers ${n.id}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('route every connector of the architecture example around unrelated boxes', () => {
    const { doc } = compile(examples.find(([f]) => f.startsWith('system'))[1])
    const nodes = Object.values(doc).filter((e) => e.type === 'node')
    const routes = createRouter()(doc, routingObstacles(nodes))
    for (const e of Object.values(doc).filter((x) => x.type === 'edge')) {
      for (const n of nodes) if (n.shape !== 'zone' && n.shape !== 'frame' && n.id !== e.from.id && n.id !== e.to.id) expect(crossesRect(routes.get(e.id), n), `${e.id} crosses ${n.id}`).toBe(false)
    }
  })
})

describe('compiled semantics', () => {
  it('keeps author ids, fills catalog defaults and maps relations', () => {
    const r = compile(base({ edges: [{ from: 'a', to: 'b', kind: 'async', label: 'writes' }] }))
    expect(r.doc.a).toMatchObject({ shape: 'component', icon: 'server', color: 'blue', text: 'Service' })
    expect(r.doc.b).toMatchObject({ shape: 'cylinder', text: 'PostgreSQL' })
    expect(r.doc.e1).toMatchObject({ from: { id: 'a' }, to: { id: 'b' }, head: 'arrow', dash: 'dashed', text: 'writes' })
  })

  it('lets explicit fields override a relation', () => {
    const r = compile(base({ edges: [{ from: 'a', to: 'b', kind: 'inheritance', dash: 'dotted', head: 'open' }] }))
    expect(r.doc.e1).toMatchObject({ head: 'open', dash: 'dotted', tail: 'none' })
  })

  it('writes UML compartments, with an empty attributes compartment kept', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, nodes: [{ id: 'c', kind: 'interface', name: 'Shape', methods: ['+ area(): double'] }] })
    expect(r.doc.c.text).toBe('«interface»\nShape\n---\n---\n+ area(): double')
  })

  it('never lets label text change semantics', () => {
    const r = compile(base({ nodes: [{ id: 'a', kind: 'box', label: 'Kafka database cache' }, { id: 'b', kind: 'box' }] }))
    expect(r.doc.a.shape).toBe('rect')
  })

  it('emits zones behind their members and wraps them without moving them', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'box', x: 100, y: 100 }, { id: 'b', kind: 'box', x: 400, y: 100 }], zones: [{ id: 'z', label: 'VPC', contains: ['a', 'b'] }] })
    expect(r.doc.z.z).toBeLessThan(r.doc.a.z)
    expect(r.doc.a).toMatchObject({ x: 100, y: 100 })
    expect(r.doc.z.x).toBeLessThan(100)
    expect(r.doc.z.x + r.doc.z.w).toBeGreaterThan(400 + r.doc.b.w)
    expect(r.board.done[0].changes[0][0]).toBe('z')
  })

  it('allocates generated ids around explicit ones in every collection', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, layout: 'manual',
      nodes: [{ id: 'e1', kind: 'box', x: 0, y: 0 }, { id: 's1', kind: 'box', x: 300, y: 0 }],
      edges: [{ id: 'e2', from: 'e1', to: 's1' }, { from: 's1', to: 'e1' }],
      strokes: [{ points: [[0, 200], [50, 250]] }] })
    expect(r.errors).toEqual([])
    expect(Object.keys(r.doc).sort()).toEqual(['e1', 'e2', 'e3', 's1', 's2'])
  })

  it('supports free endpoints on either side in manual layout', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'box', x: 0, y: 0 }],
      edges: [{ from: { x: -200, y: 30 }, to: 'a' }, { from: 'a', to: { x: 400, y: 30 } }, { from: { x: 0, y: 300 }, to: { x: 200, y: 300 } }] })
    expect(r.errors).toEqual([])
    expect(Object.values(r.doc).filter((e) => e.type === 'edge')).toHaveLength(3)
  })

  it('warns about and ignores an icon on a non-component kind', () => {
    const r = compile(base({ nodes: [{ id: 'a', kind: 'box', icon: 'server' }, { id: 'b', kind: 'box' }] }))
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.path)).toEqual(['nodes[0].icon'])
    expect(r.doc.a.icon).toBeUndefined()
  })

  it('reports ignored fields and the theme as warnings', () => {
    const r = compile(base({ theme: 'dark', nodes: [{ id: 'a', kind: 'service', colour: 'red' }, { id: 'b', kind: 'box' }] }))
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => w.path)).toEqual(['theme', 'nodes[0].colour'])
    expect(r.warnings[1].message).toMatch(/Did you mean "color"/)
  })
})

describe('diagnostics', () => {
  const cases = [
    ['wrong format', { format: 'excalidraw', version: 1 }, 'format'],
    ['wrong version', { format: 'boxwire-diagram', version: 2 }, 'version'],
    ['not an object', [], ''],
    ['unknown kind, with suggestion', base({ nodes: [{ id: 'a', kind: 'servce' }] }), 'nodes[0].kind'],
    ['zone kind as a node', base({ nodes: [{ id: 'a', kind: 'region' }] }), 'nodes[0].kind'],
    ['duplicate ids across collections', base({ zones: [{ id: 'a', contains: ['b'] }] }), 'zones[0].id'],
    ['reserved id', base({ nodes: [{ id: 'constructor', kind: 'box' }, { id: 'b', kind: 'box' }] }), 'nodes[0].id'],
    ['__proto__ id', JSON.parse('{"format":"boxwire-diagram","version":1,"nodes":[{"id":"__proto__","kind":"box"}]}'), 'nodes[0].id'],
    ['bad id characters', base({ nodes: [{ id: '1 bad', kind: 'box' }, { id: 'b', kind: 'box' }] }), 'nodes[0].id'],
    ['dangling edge', base({ edges: [{ from: 'a', to: 'nope' }] }), 'edges[0].to'],
    ['self loop', base({ edges: [{ from: 'a', to: 'a' }] }), 'edges[0]'],
    ['unknown relation', base({ edges: [{ from: 'a', to: 'b', kind: 'inherits' }] }), 'edges[0].kind'],
    ['reserved colour', base({ nodes: [{ id: 'a', kind: 'box', color: '__proto__' }, { id: 'b', kind: 'box' }] }), 'nodes[0].color'],
    ['NaN coordinate', { format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'box', x: NaN, y: 0 }] }, 'nodes[0].x'],
    ['huge coordinate', { format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'box', x: 1e9, y: 0 }] }, 'nodes[0].x'],
    ['missing position in manual', { format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'box' }] }, 'nodes[0]'],
    ['position in auto', base({ nodes: [{ id: 'a', kind: 'box', x: 0, y: 0 }, { id: 'b', kind: 'box' }] }), 'nodes[0]'],
    ['free point in auto', base({ edges: [{ from: 'a', to: { x: 0, y: 0 } }] }), 'edges[0].to'],
    ['strokes in auto', base({ strokes: [{ points: [[0, 0], [1, 1]] }] }), 'strokes'],
    ['label on a UML class', { format: 'boxwire-diagram', version: 1, nodes: [{ id: 'c', kind: 'class', name: 'A', label: 'A' }] }, 'nodes[0].label'],
    ['UML class without a name', { format: 'boxwire-diagram', version: 1, nodes: [{ id: 'c', kind: 'class' }] }, 'nodes[0].name'],
    ['compartment separator in a line', { format: 'boxwire-diagram', version: 1, nodes: [{ id: 'c', kind: 'class', name: 'A', attributes: ['---'] }] }, 'nodes[0].attributes[0]'],
    ['table column with a space', { format: 'boxwire-diagram', version: 1, nodes: [{ id: 't', kind: 'table', name: 'users', columns: [{ name: 'first name', type: 'text' }] }] }, 'nodes[0].columns[0].name'],
    ['unknown column key', { format: 'boxwire-diagram', version: 1, nodes: [{ id: 't', kind: 'table', name: 'users', columns: ['id uuid PRIMARY'] }] }, 'nodes[0].columns[0].key'],
    ['oversized label', base({ nodes: [{ id: 'a', kind: 'box', label: 'x'.repeat(2001) }, { id: 'b', kind: 'box' }] }), 'nodes[0].label'],
    ['content too large after fitting', { format: 'boxwire-diagram', version: 1, nodes: [{ id: 't', kind: 'table', name: 'big', textSize: 'xl', columns: Array.from({ length: 200 }, (_, i) => `c${i} text`) }] }, 'nodes[0]'],
    ['too many elements', { format: 'boxwire-diagram', version: 1, nodes: Array.from({ length: 1500 }, (_, i) => ({ id: `n${i}`, kind: 'box' })), edges: Array.from({ length: 3000 }, (_, i) => ({ from: `n${i % 1500}`, to: `n${(i + 1) % 1500}` })), zones: Array.from({ length: 200 }, (_, i) => ({ id: `z${i}`, contains: ['n0'] })), strokes: Array.from({ length: 301 }, () => ({ points: [[0, 0], [1, 1]] })) }, ''],
    ['wrong types everywhere', { format: 'boxwire-diagram', version: 1, nodes: 'a', edges: {}, zones: 3 }, 'nodes'],
  ]
  for (const [name, input, path] of cases) {
    it(name, () => {
      const r = compile(input)
      expect(r.board).toBeUndefined()
      expect(r.errors.length).toBeGreaterThan(0)
      if (path !== null) expect(paths(r)).toContain(path)
    })
  }

  it('a node with a bad kind does not also make its edges "unknown"', () => {
    const r = compile(base({ nodes: [{ id: 'a', kind: 'servce' }, { id: 'b', kind: 'box' }] }))
    expect(paths(r)).toEqual(['nodes[0].kind'])
  })

  it('suggests the nearest kind', () => {
    expect(compile(base({ nodes: [{ id: 'a', kind: 'sql-databse' }, { id: 'b', kind: 'box' }] })).errors[0].message).toMatch(/Did you mean "sql-database"/)
  })
})

describe('reviewer regressions', () => {
  it('A: generated edge ids follow edges[] order, not drawing order', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, nodes: [{ id: 'a', kind: 'box' }, { id: 'b', kind: 'box' }, { id: 'c', kind: 'box' }],
      edges: [{ from: 'b', to: 'c', label: 'first' }, { from: 'a', to: 'b', label: 'second' }] })
    expect(r.doc.e1.text).toBe('first')
    expect(r.doc.e2.text).toBe('second')
  })

  it('B: stereotypes and names cannot inject compartments', () => {
    const cls = (extra) => compile({ format: 'boxwire-diagram', version: 1, nodes: [{ id: 'a', kind: 'class', name: 'Order', ...extra }] })
    expect(paths(cls({ stereotype: 'service\n---\nInjected' }))).toContain('nodes[0].stereotype')
    expect(paths(cls({ stereotype: '---' }))).toContain('nodes[0].stereotype')
    expect(paths(cls({ name: '' }))).toContain('nodes[0].name')
    expect(paths(cls({ name: '   ' }))).toContain('nodes[0].name')
    expect(paths(compile({ format: 'boxwire-diagram', version: 1, nodes: [{ id: 't', kind: 'table', name: '', columns: ['id uuid'] }] }))).toContain('nodes[0].name')
  })

  it('B: an abstract-class cannot be made concrete', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, nodes: [{ id: 'a', kind: 'abstract-class', name: 'Spot', abstract: false }] })
    expect(paths(r)).toContain('nodes[0].abstract')
  })

  it('C: in-range coordinates that make an oversized stroke get a specific error', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'box', x: 0, y: 0 }], strokes: [{ points: [[-100000, 0], [100000, 0]] }] })
    expect(paths(r)).toContain('strokes[0].points')
    expect(r.errors.some((e) => /internal/.test(e.message))).toBe(false)
  })

  it('C: structured content over the per-node text limit gets a specific error', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, nodes: [{ id: 'c', kind: 'class', name: 'A', textSize: 's', attributes: Array.from({ length: 110 }, () => '+ ' + 'x'.repeat(190)) }] })
    expect(paths(r)).toContain('nodes[0]')
    expect(r.errors[0].message).toMatch(/20000/)
    expect(r.errors.some((e) => /internal/.test(e.message))).toBe(false)
  })

  it('D: huge unknown values and keys are cheap to diagnose and echoed briefly', () => {
    const huge = 'x'.repeat(1_000_000)
    const t = performance.now()
    const r = compile({ format: 'boxwire-diagram', version: 1, [huge]: 1, nodes: [{ id: 'a', kind: huge, [huge]: 1 }, { id: 'b', kind: 'box' }], edges: [{ from: 'a', to: 'b', kind: huge }] })
    expect(performance.now() - t).toBeLessThan(200)
    for (const p of [...r.errors, ...r.warnings]) {
      expect(p.path.length).toBeLessThan(200)
      expect(p.message.length).toBeLessThan(400)
    }
  })

  it('requires at least one node, even with strokes', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [], strokes: [{ points: [[0, 0], [5, 5]] }] })
    expect(paths(r)).toContain('nodes')
  })
})

describe('auto layout', () => {
  const nodes = (n) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, w: 160, h: 72 }))
  const shapes = {
    cycle: [['n0', 'n1'], ['n1', 'n2'], ['n2', 'n0']],
    'self loop + parallel edges': [['n0', 'n0'], ['n0', 'n1'], ['n0', 'n1'], ['n1', 'n2']],
    'multiple roots, disconnected': [['n0', 'n2'], ['n1', 'n2'], ['n3', 'n4']],
    'dense random': Array.from({ length: 60 }, (_, i) => [`n${(i * 7) % 20}`, `n${(i * 13 + 3) % 20}`]),
  }
  for (const [name, pairs] of Object.entries(shapes)) {
    it(`terminates deterministically without overlaps: ${name}`, () => {
      const ns = nodes(20)
      const es = pairs.map(([from, to]) => ({ from, to }))
      const a = layeredLayout(ns, es), b = layeredLayout(ns, es)
      expect([...a]).toEqual([...b])
      expect(a.size).toBe(20)
      const rects = ns.map((n) => ({ ...n, ...a.get(n.id) }))
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(intersects(rects[i], rects[j])).toBe(false)
    })
  }

  it('lays a chain out straight along the flow', () => {
    const at = layeredLayout(nodes(4), [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }])
    const ys = [...at.values()].map((p) => p.y)
    expect(new Set(ys).size).toBe(1)
    expect(at.get('n1').x).toBeGreaterThan(at.get('n0').x)
  })

  describe('rank hints', () => {
    const chain = { format: 'boxwire-diagram', version: 1, nodes: ['client', 'lb', 'svc', 'db'].map((id) => ({ id, kind: id === 'client' ? 'web-client' : id === 'db' ? 'sql-database' : 'service' })), edges: [{ from: 'client', to: 'lb' }, { from: 'lb', to: 'svc' }, { from: 'svc', to: 'db' }] }
    const withJob = (rank) => ({ ...chain, nodes: [...chain.nodes, { id: 'job', kind: 'scheduler', ...(rank !== undefined && { rank }) }], edges: [...chain.edges, { from: 'job', to: 'db' }] })

    it('a batch source with no hint lands in rank 0, beside the client', () => {
      const r = compile(withJob())
      expect(r.doc.job.x).toBe(r.doc.client.x)
    })

    it('a hint moves it to that rank, and nothing else moves along the flow', () => {
      const plain = compile(withJob()).doc, hinted = compile(withJob(2)).doc
      expect(hinted.job.x).toBe(hinted.svc.x)
      for (const id of ['client', 'lb', 'svc', 'db']) expect(hinted[id].x).toBe(plain[id].x)
    })

    it('ranks after a hinted node still follow its edges, and a hint past the end closes up', () => {
      const r = compile(withJob(50)).doc
      expect(r.job.x).toBeGreaterThan(r.svc.x)
      expect(r.db.x).toBeGreaterThan(r.job.x)
    })

    it('a hinted node with no edges joins the flow instead of the loose band', () => {
      const v = { ...chain, nodes: [...chain.nodes, { id: 'note', kind: 'note', label: 'n', rank: 1 }] }
      const r = compile(v).doc
      expect(r.note.x + r.note.w / 2).toBe(r.lb.x + r.lb.w / 2)
    })

    it('must be a whole number from 0 to 100, and is ignored (with a warning) in manual layout', () => {
      expect(compileDiagram(withJob(1.5), { measure }).errors.map((e) => e.path)).toEqual(['nodes[4].rank'])
      expect(compileDiagram(withJob(101), { measure }).errors.map((e) => e.path)).toEqual(['nodes[4].rank'])
      const manual = { format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'service', x: 0, y: 0, rank: 2 }] }
      expect(compileDiagram(manual, { measure }).warnings.map((w) => w.path)).toEqual(['nodes[0].rank'])
    })

    it('the typeahead reference puts its hourly builder beside the serving path, not in rank 0', () => {
      const r = compile(JSON.parse(readFileSync(new URL('../problems/solutions/typeahead.boxwire-diagram.json', import.meta.url), 'utf8'))).doc
      expect(r.builder.x).toBe(r.lb.x)
      expect(r.builder.x).toBeGreaterThan(r.client.x)
    })
  })

  it('puts UML parents above their children in TB', () => {
    const r = compile({ format: 'boxwire-diagram', version: 1, direction: 'TB', nodes: [{ id: 'kid', kind: 'class', name: 'Car' }, { id: 'parent', kind: 'abstract-class', name: 'Vehicle' }], edges: [{ from: 'kid', to: 'parent', kind: 'inheritance' }] })
    expect(r.doc.parent.y).toBeLessThan(r.doc.kid.y)
  })
})

describe('JSON Schema stays in sync with the compiler', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../../public/products/boxwire/schema.json', import.meta.url), 'utf8'))
  const defs = schema.$defs
  const sorted = (a) => [...a].sort()
  it('the published file is exactly the generated schema (regenerate: see author/schema.js)', () => {
    expect(schema).toEqual(buildSchema())
  })

  it('lists exactly the compiler vocabulary', () => {
    expect(sorted(defs.nodeKind.enum)).toEqual(sorted(Object.keys(NODE_KINDS)))
    expect(sorted(defs.relation.enum)).toEqual(sorted(Object.keys(RELATIONS)))
    expect(sorted(defs.color.enum)).toEqual(sorted(COLORS))
    expect(sorted(defs.icon.enum)).toEqual(sorted(ICONS))
    expect(sorted(defs.fill.enum)).toEqual(sorted(FILLS))
    expect(sorted(defs.dash.enum)).toEqual(sorted(DASHES))
    expect(sorted(defs.side.enum)).toEqual(sorted(SIDES))
    expect(sorted(defs.route.enum)).toEqual(sorted(ROUTES))
    expect(sorted(defs.head.enum)).toEqual(sorted(HEADS))
    expect(sorted(defs.columnKey.enum)).toEqual(sorted(KEYS))
    expect(sorted(defs.textSize.enum)).toEqual(sorted(Object.keys(TEXT_SIZES)))
  })
})

describe('JSON Schema validation (strict single-object lint)', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../../public/products/boxwire/schema.json', import.meta.url), 'utf8'))
  // conditional `required` is standard JSON Schema; only Ajv's extra strictRequired lint objects to it
  const validate = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(schema)
  const ok = (doc) => validate(typeof doc === 'string' ? JSON.parse(doc) : doc)
  const one = (node, extra = {}) => ({ format: 'boxwire-diagram', version: 1, nodes: [node], ...extra })

  it('accepts every public example', () => {
    for (const [file, text] of examples) expect(ok(text), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true)
  })

  it('accepts what the compiler accepts in the semantic cases', () => {
    for (const doc of [
      base({ edges: [{ from: 'a', to: 'b', kind: 'inheritance', dash: 'dotted', head: 'open' }] }),
      one({ id: 'c', kind: 'interface', name: 'Shape', methods: ['+ area(): double'] }),
      { format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'box', x: 0, y: 0 }], edges: [{ from: { x: -200, y: 30 }, to: 'a' }] },
      one({ id: 't', kind: 'table', name: 'users', columns: ['id uuid PK', { name: 'email', type: 'text', key: 'UQ' }] }),
      base({ positions: { a: { x: 0, y: 0, w: 200 } }, zones: [{ id: 'z', contains: ['a'], trust: 'restricted' }] }),
      one({ id: 'a', kind: 'service', meta: { owner: 'payments-team', 'data-class': 'pii' } }),
      { format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'box' }], positions: { a: { x: 1, y: 2 } } },
    ]) {
      expect(ok(doc), JSON.stringify(validate.errors)).toBe(true)
      expect(compile(doc).errors).toEqual([])
    }
  })

  const invalid = {
    'class without a name': one({ id: 'c', kind: 'class' }),
    'class with a blank name': one({ id: 'c', kind: 'class', name: ' ' }),
    'reserved id': one({ id: 'constructor', kind: 'box' }),
    'manual node without x/y': one({ id: 'a', kind: 'box' }, { layout: 'manual' }),
    'auto node with x/y': one({ id: 'a', kind: 'box', x: 1, y: 2 }),
    'separator attribute': one({ id: 'c', kind: 'class', name: 'A', attributes: ['---'] }),
    'multi-line attribute': one({ id: 'c', kind: 'class', name: 'A', attributes: ['a\nb'] }),
    'stereotype injection': one({ id: 'c', kind: 'class', name: 'A', stereotype: 's\n---\nx' }),
    'label on a class': one({ id: 'c', kind: 'class', name: 'A', label: 'A' }),
    'concrete abstract-class': one({ id: 'c', kind: 'abstract-class', name: 'A', abstract: false }),
    'values on a class': one({ id: 'c', kind: 'class', name: 'A', values: ['X'] }),
    'methods on an enum': one({ id: 'c', kind: 'enum', name: 'E', methods: ['x'] }),
    'table name with a space': one({ id: 't', kind: 'table', name: 'order items', columns: ['id uuid'] }),
    'table without columns': one({ id: 't', kind: 'table', name: 't' }),
    'bad column key': one({ id: 't', kind: 'table', name: 't', columns: ['id uuid PRIMARY'] }),
    'text without a label': one({ id: 'x', kind: 'text' }),
    'icon on a box': one({ id: 'b', kind: 'box', icon: 'server' }),
    'name on a box': one({ id: 'b', kind: 'box', name: 'B' }),
    'no nodes': { format: 'boxwire-diagram', version: 1, nodes: [] },
    'strokes in auto': one({ id: 'a', kind: 'box' }, { strokes: [{ points: [[0, 0], [1, 1]] }] }),
    'free point in auto': base({ edges: [{ from: 'a', to: { x: 0, y: 0 } }] }),
    'side on a free end': { format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'a', kind: 'box', x: 0, y: 0 }], edges: [{ from: { x: 0, y: 0 }, to: 'a', fromSide: 'n' }] },
    'unknown top-level field': one({ id: 'a', kind: 'box' }, { theme: 'dark' }),
    'unknown trust': base({ zones: [{ id: 'z', contains: ['a'], trust: 'secret' }] }),
    'meta key with a capital': one({ id: 'a', kind: 'box', meta: { Owner: 'x' } }),
    'reserved meta key': one({ id: 'a', kind: 'box', meta: { constructor: 'x' } }),
    'non-string meta': one({ id: 'a', kind: 'box', meta: { owner: 1 } }),
    'position without y': base({ positions: { a: { x: 0 } } }),
    'position with an unknown field': base({ positions: { a: { x: 0, y: 0, z: 1 } } }),
  }
  for (const [name, doc] of Object.entries(invalid)) {
    it(`rejects: ${name}`, () => {
      expect(ok(doc)).toBe(false)
      // and the compiler never accepts it silently: it errors, or (for unknown fields) warns
      const r = compile(doc)
      expect(r.errors.length + r.warnings.length).toBeGreaterThan(0)
    })
  }
})

describe('format additions: positions, zone trust and members, node meta', () => {
  const v1 = (extra) => ({ format: 'boxwire-diagram', version: 1, ...extra })
  const manual = (extra) => v1({ layout: 'manual', nodes: [{ id: 'a', kind: 'box', x: 0, y: 0 }, { id: 'b', kind: 'box' }], positions: { b: { x: 300, y: 40 } }, ...extra })

  it('manual: a position places a node that has no x/y of its own', () => {
    const r = compile(manual())
    expect(r.errors).toEqual([])
    expect(r.doc.b).toMatchObject({ x: 300, y: 40 })
  })

  it('manual: a position replaces the node\'s own x/y, and its w/h replace the node\'s', () => {
    const r = compile(manual({ nodes: [{ id: 'a', kind: 'box', x: 0, y: 0, w: 100 }, { id: 'b', kind: 'box', x: 5, y: 5 }], positions: { a: { x: 10, y: 20, w: 300 }, b: { x: 300, y: 40 } } }))
    expect(r.errors).toEqual([])
    expect(r.doc.a).toMatchObject({ x: 10, y: 20, w: 300 })
    expect(r.doc.b).toMatchObject({ x: 300, y: 40 })
  })

  it('auto: listed nodes are pinned after layout; the others keep their places', () => {
    const plain = compile(base())
    const pinned = compile(base({ positions: { b: { x: 900, y: -50 } } }))
    expect(pinned.errors).toEqual([])
    expect(pinned.doc.b).toMatchObject({ x: 900, y: -50 })
    expect(pinned.doc.a).toEqual(plain.doc.a)
  })

  it('diagnoses position entries with paths', () => {
    const p = (positions, extra) => paths(compile(base({ positions, ...extra })))
    expect(p({ api: { x: 0, y: 0 } })).toEqual(['positions.api'])
    expect(compile(base({ positions: { bb: { x: 0, y: 0 } } })).errors[0].message).toMatch(/unknown node "bb"\. Did you mean "b"\?/)
    expect(p({ z: { x: 0, y: 0 } }, { zones: [{ id: 'z', contains: ['a'] }] })).toEqual(['positions.z'])
    expect(p({ a: { x: 0 } })).toEqual(['positions.a.y'])
    expect(p({ a: { x: 0, y: 1e9 } })).toEqual(['positions.a.y'])
    expect(p({ a: { x: 0, y: 0, w: 1 } })).toEqual(['positions.a.w'])
    expect(p({ a: [0, 0] })).toEqual(['positions.a'])
    expect(p([])).toEqual(['positions'])
    expect(compile(base({ positions: { a: { x: 0, y: 0, z: 1 } } })).warnings.map((w) => w.path)).toEqual(['positions.a.z'])
    // manual nodes still need a place from somewhere
    expect(paths(compile(manual({ positions: undefined })))).toEqual(['nodes[1]'])
  })

  it('carries zone trust and declared members (sorted) on zones and frames', () => {
    const r = compile(base({ zones: [{ id: 'z', contains: ['b', 'a'], trust: 'sensitive' }], frames: [{ id: 'f', contains: ['z', 'b', 'a'] }] }))
    expect(r.errors).toEqual([])
    expect(r.doc.z).toMatchObject({ trust: 'sensitive', members: ['a', 'b'] })
    expect(r.doc.f.members).toEqual(['a', 'b', 'z'])
    expect(compile(base({ zones: [{ id: 'z', contains: ['a'] }] })).doc.z.trust).toBeUndefined()
    const bad = compile(base({ zones: [{ id: 'z', contains: ['a'], trust: 'internl' }] }))
    expect(paths(bad)).toEqual(['zones[0].trust'])
    expect(bad.errors[0].message).toMatch(/Did you mean "internal"/)
    expect(TRUST_LEVELS).toEqual(['public', 'internal', 'restricted', 'sensitive'])
  })

  it('carries node meta and diagnoses it', () => {
    const r = compile(base({ nodes: [{ id: 'a', kind: 'service', meta: { owner: 'payments-team', data: 'pii' } }, { id: 'b', kind: 'box', meta: {} }] }))
    expect(r.errors).toEqual([])
    expect(r.doc.a.meta).toEqual({ owner: 'payments-team', data: 'pii' })
    expect(r.doc.b.meta).toBeUndefined()
    const p = (meta) => paths(compile(base({ nodes: [{ id: 'a', kind: 'box', meta }, { id: 'b', kind: 'box' }] })))
    expect(p('owner')).toEqual(['nodes[0].meta'])
    expect(p(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])))).toEqual(['nodes[0].meta'])
    expect(p({ Owner: 'x' })).toEqual(['nodes[0].meta.Owner'])
    expect(p({ constructor: 'x' })).toEqual(['nodes[0].meta.constructor'])
    expect(p({ owner: 3 })).toEqual(['nodes[0].meta.owner'])
    expect(p({ owner: 'x'.repeat(121) })).toEqual(['nodes[0].meta.owner'])
  })

  it('assignIds gives the same edge and stroke ids as the compiled board', () => {
    const input = { format: 'boxwire-diagram', version: 1, layout: 'manual', nodes: [{ id: 'e1', kind: 'box', x: 0, y: 0 }, { id: 's1', kind: 'box', x: 300, y: 0 }],
      edges: [{ id: 'e2', from: 'e1', to: 's1' }, { from: 's1', to: 'e1' }, { from: 'e1', to: 's1' }], strokes: [{ points: [[0, 200], [50, 250]] }] }
    const r = compile(input)
    expect(assignIds(input)).toEqual({ edges: ['e2', 'e3', 'e4'], strokes: ['s2'] })
    for (const id of [...assignIds(input).edges, ...assignIds(input).strokes]) expect(r.doc[id]).toBeDefined()
  })

  it('the board validator checks the new element fields', () => {
    const { doc } = compile(base({ nodes: [{ id: 'a', kind: 'service', meta: { owner: 'x' } }, { id: 'b', kind: 'box' }], zones: [{ id: 'z', contains: ['a'], trust: 'internal' }] }))
    for (const el of Object.values(doc)) expect(elementProblem(el)).toBeNull()
    expect(elementProblem({ ...doc.a, meta: { owner: 5 } })).toMatch(/meta/)
    expect(elementProblem({ ...doc.a, meta: { toString: 'x' } })).toMatch(/meta key/)
    expect(elementProblem({ ...doc.z, trust: 'top-secret' })).toBe('bad trust')
    expect(elementProblem({ ...doc.a, trust: 'public' })).toBe('bad trust')
    expect(elementProblem({ ...doc.z, members: ['a', 7] })).toBe('bad members')
    expect(elementProblem({ ...doc.a, members: ['a'] })).toBe('bad members')
  })
})

describe('the public guide documents the whole vocabulary', () => {
  const guide = readFileSync(new URL('../../../../public/products/boxwire/llm.md', import.meta.url), 'utf8')
  it('names every kind, relation and icon', () => {
    for (const word of [...Object.keys(NODE_KINDS), ...Object.keys(RELATIONS), ...ICONS, ...COLORS, ...HEADS]) expect(guide, word).toContain('`' + word + '`')
  })
  it('compiles its inline example', () => {
    const block = /```json\n([\s\S]*?)```/.exec(guide)[1]
    const r = compile(block)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })
})
