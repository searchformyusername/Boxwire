// Deterministic layered layout for authored diagrams (a compact Sugiyama):
// break cycles by DFS, rank by longest path, order each rank by barycentre
// sweeps (keeping the ordering with the fewest crossings), then place ranks
// along the flow and nodes across it, pulled toward their predecessors so
// chains come out straight. Same input, same output, always terminates.

const SWEEPS = 8

/**
 * nodes: [{ id, w, h }] in document order; edges: [{ from, to }] (ids, any multiplicity).
 * opts.minRank: Map<id, rank>, the earliest rank a node may take (a hint for sources such as a batch
 * job, which would otherwise sit in rank 0 beside the clients); ranks after it still follow the edges.
 * Returns Map<id, { x, y }> (top-left corners).
 */
export function layeredLayout(nodes, edges, opts = {}) {
  // Nodes with no edges (notes, rejected options, legends) don't belong to any rank. They go in a
  // band after the connected drawing, so they never sit inside the flow or a frame drawn around it.
  // A node with a rank hint asked for a place in the flow, so it is ranked even without edges.
  const linked = new Set(opts.minRank?.keys() ?? [])
  for (const e of edges) if (e.from !== e.to) linked.add(e.from), linked.add(e.to)
  const loose = nodes.filter((n) => !linked.has(n.id))
  if (!loose.length || loose.length === nodes.length) return layered(nodes, edges, opts)
  const at = layered(nodes.filter((n) => linked.has(n.id)), edges, opts)
  const placed = nodes.filter((n) => at.has(n.id)).map((n) => ({ ...n, ...at.get(n.id) }))
  const x0 = Math.min(...placed.map((n) => n.x)), x1 = Math.max(...placed.map((n) => n.x + n.w))
  let y = Math.max(...placed.map((n) => n.y + n.h)) + BAND_GAP
  let x = x0, rowH = 0
  const width = Math.max(x1 - x0, 900)
  for (const n of loose) {
    if (x > x0 && x + n.w > x0 + width) [x, y, rowH] = [x0, y + rowH + (opts.nodeGap ?? 56), 0]
    at.set(n.id, { x: Math.round(x) || 0, y: Math.round(y) || 0 })
    x += n.w + (opts.nodeGap ?? 56)
    rowH = Math.max(rowH, n.h)
  }
  return at
}

/** Room between the drawing and the band of unconnected nodes: a frame's padding and title fit in it. */
const BAND_GAP = 150

function layered(nodes, edges, { direction = 'LR', rankGap = 110, nodeGap = 56, minRank } = {}) {
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const out = nodes.map(() => new Set())
  for (const e of edges) {
    const a = index.get(e.from), b = index.get(e.to)
    if (a !== undefined && b !== undefined && a !== b) out[a].add(b)
  }

  // 1. Acyclic: reverse edges that point back into the DFS stack.
  const dag = nodes.map(() => [])
  const state = new Uint8Array(nodes.length) // 0 new, 1 on stack, 2 done
  for (let root = 0; root < nodes.length; root++) {
    if (state[root]) continue
    const stack = [[root, [...out[root]], 0]]
    state[root] = 1
    while (stack.length) {
      const top = stack[stack.length - 1]
      const [v, next] = top
      if (top[2] === next.length) {
        state[v] = 2
        stack.pop()
        continue
      }
      const w = next[top[2]++]
      if (state[w] === 1) dag[w].push(v) // back edge: keep the connection, flip its direction
      else {
        dag[v].push(w)
        if (!state[w]) {
          state[w] = 1
          stack.push([w, [...out[w]], 0])
        }
      }
    }
  }
  for (const list of dag) list.splice(0, list.length, ...new Set(list))

  // 2. Ranks by longest path (Kahn's order, ties by document order).
  const indeg = new Uint32Array(nodes.length)
  for (const list of dag) for (const w of list) indeg[w]++
  const rank = new Uint32Array(nodes.length)
  if (minRank) nodes.forEach((n, i) => (rank[i] = minRank.get(n.id) ?? 0))
  const queue = []
  for (let i = 0; i < nodes.length; i++) if (!indeg[i]) queue.push(i)
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi]
    for (const w of dag[v]) {
      rank[w] = Math.max(rank[w], rank[v] + 1)
      if (!--indeg[w]) queue.push(w)
    }
  }
  if (minRank) {
    // a hint past the last rank leaves empty ranks between; close them up (order is kept)
    const used = [...new Set(rank)].sort((a, b) => a - b)
    const dense = new Map(used.map((r, i) => [r, i]))
    for (let i = 0; i < nodes.length; i++) rank[i] = dense.get(rank[i])
  }
  const preds = nodes.map(() => [])
  for (let v = 0; v < nodes.length; v++) for (const w of dag[v]) preds[w].push(v)

  // 3. Order within ranks.
  const layers = []
  for (let i = 0; i < nodes.length; i++) (layers[rank[i]] ??= []).push(i)
  const pos = new Float64Array(nodes.length)
  const setPos = () => layers.forEach((layer) => layer.forEach((v, i) => (pos[v] = i)))
  setPos()
  const crossings = () => {
    let c = 0
    for (let r = 1; r < layers.length; r++) {
      const segs = []
      for (const w of layers[r]) for (const v of preds[w]) if (rank[v] === r - 1) segs.push([pos[v], pos[w]])
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) c++
    }
    return c
  }
  const reorder = (layer, neighbours) => {
    const key = new Map(layer.map((v, i) => {
      const ns = neighbours[v]
      return [v, ns.length ? ns.reduce((s, u) => s + pos[u], 0) / ns.length : i]
    }))
    layer.sort((a, b) => key.get(a) - key.get(b) || pos[a] - pos[b])
    layer.forEach((v, i) => (pos[v] = i))
  }
  let best = { score: crossings(), layers: layers.map((l) => [...l]) }
  for (let s = 0; s < SWEEPS && best.score > 0; s++) {
    if (s % 2 === 0) for (let r = 1; r < layers.length; r++) reorder(layers[r], preds)
    else for (let r = layers.length - 2; r >= 0; r--) reorder(layers[r], dag)
    const score = crossings()
    if (score < best.score) best = { score, layers: layers.map((l) => [...l]) }
  }
  layers.splice(0, layers.length, ...best.layers)
  setPos()

  // 4. Coordinates: main axis follows the flow, cross axis spreads each rank.
  const lr = direction !== 'TB'
  const main = (n) => (lr ? n.w : n.h)
  const cross = (n) => (lr ? n.h : n.w)
  const at = new Map()
  const crossStart = new Float64Array(nodes.length)
  let mainCursor = 0
  for (const layer of layers) {
    const depth = Math.max(...layer.map((v) => main(nodes[v])))
    // each node wants to be centred on its predecessors; then overlaps are pushed apart in order
    let edge = -Infinity
    for (const v of layer) {
      const placed = preds[v].filter((u) => rank[u] < rank[v])
      const want = placed.length ? placed.reduce((s, u) => s + crossStart[u] + cross(nodes[u]) / 2, 0) / placed.length - cross(nodes[v]) / 2 : edge === -Infinity ? 0 : edge
      crossStart[v] = Math.max(want, edge)
      edge = crossStart[v] + cross(nodes[v]) + nodeGap
    }
    // shift the whole rank back toward its wishes (order and spacing are preserved)
    const anchored = layer.filter((v) => preds[v].some((u) => rank[u] < rank[v]))
    if (anchored.length) {
      const drift = anchored.reduce((s, v) => {
        const ps = preds[v].filter((u) => rank[u] < rank[v])
        return s + ps.reduce((t, u) => t + crossStart[u] + cross(nodes[u]) / 2, 0) / ps.length - (crossStart[v] + cross(nodes[v]) / 2)
      }, 0) / anchored.length
      for (const v of layer) crossStart[v] += Math.min(0, drift)
    } else {
      const span = edge - nodeGap - crossStart[layer[0]]
      for (const v of layer) crossStart[v] -= span / 2
    }
    for (const v of layer) {
      const n = nodes[v]
      const m = mainCursor + (depth - main(n)) / 2
      at.set(n.id, lr ? { x: Math.round(m) || 0, y: Math.round(crossStart[v]) || 0 } : { x: Math.round(crossStart[v]) || 0, y: Math.round(m) || 0 }) // || 0: no -0, which a JSON round trip turns into 0
    }
    mainCursor += depth + rankGap
  }
  return at
}
