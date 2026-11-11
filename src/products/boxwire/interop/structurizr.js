// A Structurizr DSL subset, parsed by hand. Supported: `workspace` with a
// name; `model` with `person`, `softwareSystem`, `container` and `component`
// (assigned to identifiers or not, `!identifiers hierarchical` included),
// their description / technology / tags, `group` blocks (members kept, the
// boundary not drawn), and relationships (`a -> b "desc" "tech" "tags"`, and
// `-> b` / `this -> b` inside an element); `views` of kind `systemLandscape`,
// `systemContext`, `container` and `component` with `include` (`*` or ids)
// and `autoLayout`, which become frames. Deployment, dynamic and filtered
// views, styles, themes, scripts and the rest are listed in the loss report
// with their lines, never dropped silently.

import { idAllocator, label, lossReport } from './report.js'

const isWord = (t) => t && t.type === 'word'

/** Tokens with line numbers: strings, words, { } = -> and line breaks. Comments are removed. */
function tokenize(text, errors, report) {
  const out = []
  let line = 1
  for (let i = 0; i < text.length;) {
    const c = text[i]
    if (c === '\n') {
      out.push({ type: 'nl', line })
      line++
      i++
      continue
    }
    // every other white space (tab, CR, NBSP, BOM, U+2028 …) separates tokens; a word below must never be empty
    if (/\s/.test(c)) { i++; continue }
    if (c === '\\' && text[i + 1] === '\n') { i += 2; line++; continue }
    if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      const start = i
      while (i < text.length && text[i] !== '\n') i++
      report.comment(line, text.slice(start + (c === '#' ? 1 : 2), i))
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      text.slice(i + 2, end < 0 ? text.length : end).split('\n').forEach((l, k) => report.comment(line + k, l.replace(/^\s*\*\s?/, '')))
      for (let k = i; k < stop; k++) if (text[k] === '\n') line++
      i = stop
      continue
    }
    if (c === '"') {
      let j = i + 1, s = ''
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') {
        if (text[j] === '\\' && (text[j + 1] === '"' || text[j + 1] === '\\')) { s += text[j + 1]; j += 2; continue }
        s += text[j++]
      }
      if (text[j] !== '"') errors.push({ line, message: 'Unterminated string: add the closing ".' })
      out.push({ type: 'string', value: s, line })
      i = j + 1
      continue
    }
    if (c === '{' || c === '}' || c === '=') { out.push({ type: c, line }); i++; continue }
    if (c === '-' && text[i + 1] === '>') { out.push({ type: '->', line }); i += 2; continue }
    let j = i
    while (j < text.length && !/[\s{}="]/.test(text[j]) && !(text[j] === '-' && text[j + 1] === '>')) j++
    if (j === i) j = i + 1 // defensive: always make progress
    out.push({ type: 'word', value: text.slice(i, j), line })
    i = j
  }
  out.push({ type: 'nl', line })
  return out
}

/** Statements: the tokens of one line, and the block that follows a trailing "{". */
function statementsOf(tokens, report) {
  let p = 0
  function block(depthClose, openLine) {
    const list = []
    let cur = []
    while (p < tokens.length) {
      const t = tokens[p++]
      if (t.type === 'nl') {
        if (cur.length) list.push({ tokens: cur, line: cur[0].line })
        cur = []
      } else if (t.type === '{') {
        const st = { tokens: cur, line: cur[0]?.line ?? t.line }
        st.body = block(true, t.line)
        list.push(st)
        cur = []
      } else if (t.type === '}') {
        if (cur.length) list.push({ tokens: cur, line: cur[0].line })
        if (depthClose) return list
        cur = []
      } else cur.push(t)
    }
    if (cur.length) list.push({ tokens: cur, line: cur[0].line })
    if (depthClose) report.add('approximated', openLine, 'unclosed block', 'the "{" opened here has no matching "}"; the block is read to the end of the text')
    return list
  }
  return block(false)
}

const ELEMENTS = { person: 'person', softwaresystem: 'softwareSystem', container: 'container', component: 'component' }
const UNSUPPORTED_MODEL = {
  deploymentenvironment: 'deployment environments are not imported',
  deploymentnode: 'deployment nodes are not imported',
  infrastructurenode: 'infrastructure nodes are not imported',
  softwaresysteminstance: 'deployment instances are not imported',
  containerinstance: 'deployment instances are not imported',
  element: 'custom elements are not imported',
  enterprise: 'the enterprise boundary is not drawn (its members are imported)',
  properties: 'properties are not imported',
  perspectives: 'perspectives are not imported',
  url: 'URLs are not imported',
  '!ref': 'element references (!ref) are not supported',
  '!extend': '!extend is not supported',
  '!include': '!include is not supported (paste the included text instead)',
  '!script': 'scripts are not run',
  '!plugin': 'plugins are not run',
  '!docs': 'documentation is not imported',
  '!adrs': 'decision records are not imported',
  '!const': 'constants are not substituted',
  '!var': 'variables are not substituted',
  '!impliedrelationships': 'implied relationships are not generated; only declared ones are drawn',
}
const VIEW_KINDS = { systemlandscape: 'systemLandscape', systemcontext: 'systemContext', container: 'container', component: 'component' }
const UNSUPPORTED_VIEWS = {
  dynamic: 'dynamic views are not imported',
  deployment: 'deployment views are not imported',
  filtered: 'filtered views are not imported',
  custom: 'custom views are not imported',
  image: 'image views are not imported',
  styles: 'styles are not imported (Boxwire colours follow each viewer\'s theme)',
  theme: 'themes are not imported',
  themes: 'themes are not imported',
  branding: 'branding is not imported',
  terminology: 'terminology is not imported',
  properties: 'view properties are not imported',
}
/** Container tags that name an architecture kind (declared tags, never names or descriptions). */
const TAG_KINDS = [['database', 'sql-database'], ['queue', 'message-queue'], ['message bus', 'message-queue'], ['topic', 'event-stream'], ['web browser', 'web-client'], ['mobile app', 'mobile-app'], ['cache', 'cache'], ['file system', 'object-storage'], ['bucket', 'object-storage']]

/**
 * Parse Structurizr DSL. Returns { value, report, errors } like parseMermaid.
 */
export function parseStructurizr(text) {
  const report = lossReport()
  const errors = []
  const tokens = tokenize(text.replace(/\r\n?/g, '\n'), errors, report)
  const top = statementsOf(tokens, report)
  const ids = idAllocator(report)
  const elements = [] // { id, type, name, description, technology, tags, parent, line, raw }
  const byRef = new Map() // identifier (as written, flat and hierarchical) → element
  const rels = []
  const views = []
  let name = null, direction = null, hierarchical = false
  const strings = (toks) => toks.filter((t) => t.type === 'string' || t.type === 'word').map((t) => t.value)

  const ws = top.find((s) => isWord(s.tokens[0]) && s.tokens[0].value.toLowerCase() === 'workspace')
  if (!ws) {
    errors.push({ line: top[0]?.line ?? 1, message: 'Expected a "workspace { … }" block. Only Structurizr DSL workspaces are supported.' })
    return { value: null, report, errors }
  }
  for (const s of top) if (s !== ws) report.add('unsupported', s.line, s.tokens[0]?.value ?? 'statement', 'outside the workspace block; not imported')
  if (ws.tokens.some((t) => isWord(t) && t.value === 'extends')) report.add('unsupported', ws.line, 'workspace extends', 'the base workspace is not loaded; only this text is imported')
  const wsArgs = ws.tokens.slice(1).filter((t) => t.type === 'string')
  if (wsArgs[0]) name = wsArgs[0].value
  if (wsArgs[1]) report.add('unsupported', ws.line, 'workspace description', 'not imported (the name is)')
  if (!ws.body) {
    errors.push({ line: ws.line, message: 'The workspace has no { … } block.' })
    return { value: null, report, errors }
  }

  function element(st, type, parent) {
    const toks = st.tokens
    let raw = null, k = 0
    if (toks[1]?.type === '=') { raw = toks[0].value; k = 2 }
    const args = strings(toks.slice(k + 1))
    const [nm, description, a3, a4] = args
    const technology = type === 'container' || type === 'component' ? a3 : undefined
    const tags = (type === 'container' || type === 'component' ? a4 : a3) ?? ''
    const el = { type, name: nm ?? raw ?? type, description, technology, tags: tags.split(',').map((x) => x.trim()).filter(Boolean), parent, line: st.line, raw, children: [] }
    elements.push(el)
    if (parent) parent.children.push(el)
    if (raw) {
      byRef.set(raw, el)
      if (hierarchical && parent?.path) byRef.set(`${parent.path}.${raw}`, el)
      el.path = hierarchical && parent?.path ? `${parent.path}.${raw}` : raw
    }
    if (st.body) body(st.body, el)
    return el
  }

  function relationship(st, source) {
    const toks = st.tokens
    let k = 0, rid = null
    if (toks[1]?.type === '=') { rid = toks[0].value; k = 2 }
    // inside a group block there is no element to be the implicit source
    const self = source?.type === 'group' ? null : source
    let from = self, arrow
    if (toks[k]?.type === '->') arrow = k
    else if (toks[k + 1]?.type === '->') { from = toks[k].value === 'this' ? self : toks[k].value; arrow = k + 1 }
    else return false
    const to = toks[arrow + 1]
    if (!isWord(to)) return false
    const [description, technology, tags] = strings(toks.slice(arrow + 2))
    rels.push({ from, to: to.value, description, technology, tags: (tags ?? '').split(',').map((x) => x.trim()).filter(Boolean), line: st.line, rid })
    if (st.body) for (const b of st.body) report.add('unsupported', b.line, 'relationship properties', `${b.tokens[0]?.value ?? 'statement'} inside a relationship block is not imported`)
    return true
  }

  function body(list, parent) {
    for (const st of list) {
      const t0 = st.tokens[0]
      if (!t0) {
        if (st.body) body(st.body, parent)
        continue
      }
      const word = t0.type === 'word' ? t0.value.toLowerCase() : ''
      const elemWord = st.tokens[1]?.type === '=' ? st.tokens[2]?.value?.toLowerCase() : word
      if (relationship(st, parent)) continue
      if (elemWord && Object.hasOwn(ELEMENTS, elemWord)) {
        const type = ELEMENTS[elemWord]
        const allowed = { person: [undefined, 'group'], softwareSystem: [undefined, 'group'], container: ['softwareSystem', 'group'], component: ['container', 'group'] }
        const parentType = parent?.type
        if (!allowed[type].includes(parentType)) {
          report.add('unsupported', st.line, type, `a ${type} inside a ${parentType ?? 'model'} is not valid here; not imported`)
          continue
        }
        // a group passes its real parent through
        element(st, type, parent?.type === 'group' ? parent.parent : parent)
        continue
      }
      if (word === 'group') {
        const nm = strings(st.tokens.slice(1))[0] ?? 'group'
        report.add('approximated', st.line, 'group', `"${nm}" boundary is not drawn; its members are imported`)
        if (st.body) body(st.body, { type: 'group', parent, path: parent?.path })
        continue
      }
      if (word === 'description' && parent && parent.type !== 'group') { parent.description = strings(st.tokens.slice(1))[0]; continue }
      if (word === 'technology' && parent && parent.type !== 'group') { parent.technology = strings(st.tokens.slice(1))[0]; continue }
      if (word === 'tags' && parent && parent.type !== 'group') { parent.tags.push(...strings(st.tokens.slice(1)).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)); continue }
      if (word === '!identifiers') {
        hierarchical = st.tokens[1]?.value?.toLowerCase() === 'hierarchical'
        continue
      }
      if (word === '!impliedrelationships' && /^(false|"false")$/i.test(st.tokens[1]?.value ?? '')) continue
      if (Object.hasOwn(UNSUPPORTED_MODEL, word)) {
        report.add(word === 'enterprise' ? 'approximated' : 'unsupported', st.line, t0.value, UNSUPPORTED_MODEL[word])
        if (word === 'enterprise' && st.body) body(st.body, parent)
        continue
      }
      report.add('unsupported', st.line, t0.value ?? 'statement', `not understood here; not imported`)
    }
  }

  for (const st of ws.body) {
    const word = st.tokens[0]?.type === 'word' ? st.tokens[0].value.toLowerCase() : ''
    if (word === 'model' && st.body) body(st.body, null)
    else if (word === 'views' && st.body) viewsOf(st.body)
    else if (word === 'name') name = strings(st.tokens.slice(1))[0] ?? name
    else if (word === 'description') report.add('unsupported', st.line, 'workspace description', 'not imported (the name is)')
    else if (word === '!identifiers') hierarchical = st.tokens[1]?.value?.toLowerCase() === 'hierarchical'
    else report.add('unsupported', st.line, st.tokens[0]?.value ?? 'statement', word === 'configuration' ? 'workspace configuration is not imported' : 'not imported')
  }

  function viewsOf(list) {
    for (const st of list) {
      const word = st.tokens[0]?.type === 'word' ? st.tokens[0].value.toLowerCase() : ''
      if (Object.hasOwn(VIEW_KINDS, word)) {
        const kind = VIEW_KINDS[word]
        const args = strings(st.tokens.slice(1))
        const scope = kind === 'systemLandscape' ? null : args[0]
        const key = kind === 'systemLandscape' ? args[0] : args[1]
        const view = { kind, scope, key, line: st.line, include: [], exclude: [], title: null }
        for (const v of st.body ?? []) {
          const w = v.tokens[0]?.type === 'word' ? v.tokens[0].value.toLowerCase() : ''
          if (w === 'include') view.include.push(...strings(v.tokens.slice(1)).map((x) => ({ x, line: v.line })))
          else if (w === 'exclude') report.add('unsupported', v.line, 'exclude', 'view exclusions are not applied; the frame keeps the included elements')
          else if (w === 'autolayout') {
            const d = (v.tokens[1]?.value ?? 'tb').toLowerCase()
            const map = { tb: 'TB', bt: 'TB', lr: 'LR', rl: 'LR' }
            if (!direction) {
              direction = map[d] ?? 'TB'
              if (d === 'bt' || d === 'rl') report.add('approximated', v.line, `autoLayout ${d}`, `reversed flow drawn as ${map[d]}`)
            }
            if (v.tokens.length > 2) report.add('approximated', v.line, 'autoLayout spacing', 'rank and node separation are not imported')
          } else if (w === 'title') view.title = strings(v.tokens.slice(1))[0]
          else if (w === 'description') report.add('unsupported', v.line, 'view description', 'not imported (the view becomes a frame with its title)')
          else if (w === 'default') report.add('unsupported', v.line, 'default view', 'frames are shown in order; none is the default')
          else report.add('unsupported', v.line, v.tokens[0]?.value ?? 'statement', 'not imported from the view')
        }
        views.push(view)
      } else if (Object.hasOwn(UNSUPPORTED_VIEWS, word)) report.add('unsupported', st.line, st.tokens[0].value, UNSUPPORTED_VIEWS[word])
      else report.add('unsupported', st.line, st.tokens[0]?.value ?? 'statement', 'not imported from views')
    }
  }

  if (errors.length) return { value: null, report, errors }
  if (!elements.length) {
    errors.push({ line: ws.line, message: 'The model declares no people, software systems, containers or components.' })
    return { value: null, report, errors }
  }

  // ---- map to Boxwire -------------------------------------------------------------------------
  // A software system with containers is a zone around them; a container with components is a zone
  // around those. Zones don't nest, so a system whose container has components is drawn around its
  // other containers, and that container's components get their own zone beside it.
  for (const el of elements) el.id = ids.take(el.path ?? el.name, el.line, `${el.type} identifier`)
  const isZone = (el) => (el.type === 'softwareSystem' || el.type === 'container') && el.children.length > 0
  const kindOf = (el) => {
    if (el.type === 'person') return 'user'
    if (el.type === 'component') return 'service'
    const tags = el.tags.map((t) => t.toLowerCase())
    if (el.type === 'container') return TAG_KINDS.find(([t]) => tags.includes(t))?.[1] ?? 'container'
    return tags.includes('external') ? 'external-api' : 'service'
  }
  const nodes = [], zones = []
  for (const el of elements) {
    if (isZone(el)) continue
    const lines = [el.name, el.technology && `[${el.type === 'container' ? 'Container' : 'Component'}: ${el.technology}]`].filter(Boolean)
    const meta = {}
    if (el.description) {
      meta.description = el.description.slice(0, 120)
      if (el.description.length > 120) report.add('approximated', el.line, 'description', `longer than 120 characters, clipped in meta.description (${el.name})`)
    }
    if (el.tags.length) {
      meta.tags = el.tags.join(', ').slice(0, 120)
      if (meta.tags.length < el.tags.join(', ').length) report.add('approximated', el.line, 'tags', `clipped to 120 characters (${el.name})`)
    }
    nodes.push({ id: el.id, kind: kindOf(el), label: label(lines.join('\n'), report, el.line, 'element name'), ...(Object.keys(meta).length && { meta }) })
  }
  for (const el of elements) {
    if (!isZone(el)) continue
    const members = el.children.filter((c) => !isZone(c)).map((c) => c.id)
    if (el.type === 'softwareSystem' && el.children.some(isZone)) report.add('approximated', el.line, 'nested boundary', `zones don't nest: "${el.name}" is drawn around its other containers, and ${el.children.filter(isZone).map((c) => `"${c.name}"`).join(', ')} beside it`)
    if (!members.length) {
      report.add('approximated', el.line, 'boundary with only nested boundaries', `"${el.name}" has no boundary of its own; its containers' boundaries are drawn`)
      el.noZone = true
      continue
    }
    zones.push({ id: el.id, label: el.name, contains: members })
  }
  report.map('person', 'kind "user"')
  report.map('softwareSystem', 'a zone around its containers, or kind "service" ("external-api" when tagged External)')
  report.map('container', 'a zone around its components, or kind "container" (tags Database, Queue, Topic, Cache, Web Browser, Mobile App, File System name a more specific kind)')
  if (elements.some((e) => e.type === 'component')) report.map('component', 'kind "service"')
  report.map('description and tags', 'node meta (description, tags); technology goes on the label')

  const resolve = (ref, line) => {
    if (ref && typeof ref === 'object') return ref
    const el = byRef.get(ref)
    if (!el) report.add('unsupported', line, 'relationship to an unknown identifier', `"${ref}" is not declared (or not assigned to an identifier)`)
    return el ?? null
  }
  // an element that isn't drawn as anything (a boundary-only system) stands in for its first drawn descendant
  const drawn = (el) => (el.noZone ? el.children.find((c) => !c.noZone) ?? null : el)
  const edges = []
  for (const r of rels) {
    const a = r.from === null ? null : resolve(r.from, r.line), b = resolve(r.to, r.line)
    if (!a || !b) {
      if (r.from === null) report.add('unsupported', r.line, 'relationship', 'a "->" with no source outside an element block')
      continue
    }
    const from = drawn(a), to = drawn(b)
    if (!from || !to || from === to) {
      report.add('unsupported', r.line, 'self relationship', `${a.name} → ${b.name}: Boxwire connectors join two different elements`)
      continue
    }
    const tags = r.tags.map((t) => t.toLowerCase())
    const async = tags.includes('async') || tags.includes('asynchronous')
    if (async) report.map('relationship tagged Async / Asynchronous', 'an async (dashed) connector')
    const text = [r.description, r.technology && `[${r.technology}]`].filter(Boolean).join('\n')
    edges.push({ ...(r.rid && { id: ids.take(r.rid, r.line, 'relationship identifier') }), from: from.id, to: to.id, ...(async && { kind: 'async' }), ...(text && { label: label(text, report, r.line, 'relationship description') }) })
  }

  // ---- views → frames ---------------------------------------------------------------------------
  const top2 = (el) => {
    let x = el
    while (x.parent) x = x.parent
    return x
  }
  const related = (set) => {
    const out = new Set()
    for (const r of rels) {
      const a = typeof r.from === 'object' ? r.from : byRef.get(r.from), b = byRef.get(r.to)
      if (!a || !b) continue
      if (set.has(a)) out.add(b)
      if (set.has(b)) out.add(a)
    }
    return out
  }
  const within = (el, scope) => {
    for (let x = el; x; x = x.parent) if (x === scope) return true
    return false
  }
  const frames = []
  for (const v of views) {
    const scope = v.scope ? byRef.get(v.scope) : null
    if (v.scope && !scope) {
      report.add('unsupported', v.line, `${v.kind} view`, `its scope "${v.scope}" is not declared`)
      continue
    }
    let members = new Set()
    const star = v.include.some((x) => x.x === '*')
    const levelOf = (el) => (v.kind === 'systemLandscape' || v.kind === 'systemContext' ? top2(el) : v.kind === 'container' ? (within(el, scope) ? el.type === 'component' ? el.parent : el : top2(el)) : el)
    if (star) {
      if (v.kind === 'systemLandscape') members = new Set(elements.filter((e) => !e.parent))
      else if (v.kind === 'systemContext') members = new Set([scope, ...[...related(new Set(elements.filter((e) => within(e, scope))))].map(top2).filter((e) => e !== scope)])
      else if (v.kind === 'container') {
        const inside = new Set(scope.children)
        members = new Set([...inside, ...[...related(new Set(elements.filter((e) => within(e, scope))))].filter((e) => !within(e, scope)).map(levelOf)])
      } else {
        const inside = new Set(scope.children)
        members = new Set([...inside, ...[...related(inside)].filter((e) => !within(e, scope))])
      }
    }
    for (const { x, line } of v.include) {
      if (x === '*') continue
      const el = byRef.get(x)
      if (el) members.add(el)
      else report.add('unsupported', line, 'include expression', `"${x}" is not an identifier Boxwire can resolve (expressions are not supported)`)
    }
    const ids2 = [...new Set([...members].map(drawn).filter(Boolean).map((e) => e.id))]
    if (!ids2.length) {
      report.add('unsupported', v.line, `${v.kind} view`, 'includes nothing Boxwire draws; no frame')
      continue
    }
    if (v.kind === 'systemContext' && isZone(scope)) report.add('approximated', v.line, 'systemContext view', `"${scope.name}" is shown with its containers, not as one box`)
    frames.push({ id: ids.take(v.key ?? `${v.kind}-${frames.length + 1}`, v.line, 'view key'), label: `${frames.length + 1} · ${v.title ?? `${v.kind === 'systemContext' ? 'System context' : v.kind === 'systemLandscape' ? 'System landscape' : v.kind === 'container' ? 'Containers' : 'Components'}${scope ? `: ${scope.name}` : ''}`}`, contains: ids2 })
  }
  if (views.length) report.map('view', 'a frame (a presentation slide) around the elements it includes')

  const value = {
    format: 'boxwire-diagram',
    version: 1,
    name: name || 'Imported Structurizr workspace',
    direction: direction ?? 'TB',
    nodes,
    edges,
    ...(zones.length && { zones }),
    ...(frames.length && { frames }),
  }
  return { value, report, errors: [] }
}
