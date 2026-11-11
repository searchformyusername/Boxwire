// Synthetic large Boxwire sources for performance measurements (scripts/boxwire-perf.mjs).
// largeSources(n, { changes }) → { baseline, proposal } JSONC texts: n nodes in layered tiers,
// ~1.7 edges per node, a third of the edges with ids, comments, capacity declarations. The proposal
// is a small edit (a relabel, a capacity change, a new node and edge), plus `changes` extra relabels.
// Deterministic: the same arguments give the same texts.

export function largeValue(n, { seed = 1 } = {}) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
  const kinds = ['web-client', 'load-balancer', 'service', 'cache', 'sql-database', 'message-queue', 'worker', 'nosql-store']
  const tiers = kinds.length
  const nodes = []
  for (let i = 0; i < n; i++) {
    const tier = Math.min(tiers - 1, Math.floor((i / n) * tiers))
    const kind = kinds[tier]
    const node = { id: `n${i}`, kind, label: `${kind} ${i}` }
    if (kind === 'web-client') node.capacity = { readQps: 100 + i, writeQps: 10 }
    else node.capacity = { replicas: 1 + (i % 3), qpsPerNode: 100000, ...(kind === 'cache' && { hitRatio: 0.9 }) }
    nodes.push(node)
  }
  const byTier = Array.from({ length: tiers }, () => [])
  nodes.forEach((nd, i) => byTier[kinds.indexOf(nd.kind)].push(i))
  const edges = []
  for (let t = 0; t < tiers - 1; t++) {
    for (const i of byTier[t]) {
      const next = byTier[t + 1]
      const k = rnd() < 0.9 ? 2 : 1
      for (let j = 0; j < k; j++) {
        const to = next[Math.floor(rnd() * next.length)]
        const e = { from: `n${i}`, to: `n${to}` }
        if (edges.length % 3 === 0) e.id = `x${edges.length}`
        if (edges.length % 7 === 0) e.label = 'calls'
        edges.push(e)
      }
    }
  }
  // drop duplicate parallel id-less edges for sanity (keep it valid)
  const seen = new Set()
  const uniq = edges.filter((e) => {
    const k = `${e.from}>${e.to}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { format: 'boxwire-diagram', version: 1, name: `Synthetic ${n}`, nodes, edges: uniq }
}

/** JSONC text in the house style: one node/edge per line, a few comments. */
export function toText(v) {
  const line = (o) => '    ' + JSON.stringify(o).replace(/":/g, '": ').replace(/,"/g, ', "')
  return [
    '{',
    '  // generated for performance measurement',
    `  "format": "boxwire-diagram",`,
    `  "version": 1,`,
    `  "name": ${JSON.stringify(v.name)},`,
    '  "nodes": [',
    v.nodes.map((o, i) => (i % 100 === 0 ? `    // tier block ${i}\n` : '') + line(o)).join(',\n'),
    '  ],',
    '  "edges": [',
    v.edges.map(line).join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n')
}

export function largeSources(n, { changes = 0 } = {}) {
  const base = largeValue(n)
  const prop = structuredClone(base)
  prop.nodes[5].label = 'renamed service'
  prop.nodes[Math.floor(n / 2)].capacity = { ...prop.nodes[Math.floor(n / 2)].capacity, replicas: 7 }
  prop.nodes.push({ id: 'added', kind: 'service', label: 'New service' })
  prop.edges.push({ id: 'added-edge', from: prop.nodes[Math.floor(n / 4)].id, to: 'added' })
  for (let i = 0; i < changes; i++) prop.nodes[(i * 37 + 11) % n].label += ' (v2)'
  return { baseline: toText(base), proposal: toText(prop), base, prop }
}
