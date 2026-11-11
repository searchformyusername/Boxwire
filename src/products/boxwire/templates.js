// Interview starter boards (positions are top-left). Each is built step by step
// through the editor so its timelapse replays the way you would draw it.

import { ALL_ITEMS, itemProps } from './catalog.js'
import { fitNode, makeEdge, makeNode } from './core/elements.js'

const n = (key, item, x, y, props = {}) => ({ kind: 'node', key, item, x, y, props })
const e = (from, to, props = {}) => ({ kind: 'edge', from, to, props })

export const TEMPLATES = [
  {
    id: 'url-shortener',
    name: 'URL shortener',
    tag: 'HLD',
    blurb: 'Read-heavy redirect path with a cache-aside read, a key service and async click analytics.',
    steps: [
      n('client', 'Web client', 0, 200, { text: 'Client' }),
      n('lb', 'Load balancer', 280, 200),
      e('client', 'lb', { text: 'GET /abc123' }),
      n('api', 'Service', 560, 200, { text: 'Shortener API' }),
      e('lb', 'api'),
      n('cache', 'Cache', 860, 60, { text: 'Redis (hot links)' }),
      e('api', 'cache', { text: 'read-through' }),
      n('db', 'SQL database', 860, 330, { text: 'URL store' }),
      e('api', 'db'),
      n('kgs', 'Service', 560, 0, { text: 'Key generator', color: 'teal', icon: 'key' }),
      e('api', 'kgs', { text: 'claim IDs', dash: 'dashed' }),
      n('q', 'Event stream', 560, 420, { text: 'Click events' }),
      e('api', 'q', { dash: 'dashed', text: 'async' }),
      n('worker', 'Worker', 860, 520, { text: 'Analytics worker' }),
      e('q', 'worker'),
      n('wh', 'Data warehouse', 1140, 520, { text: 'Warehouse' }),
      e('worker', 'wh'),
    ],
  },
  {
    id: 'chat',
    name: 'Chat system',
    tag: 'HLD',
    blurb: 'Persistent WebSocket gateways, fan-out through a log, presence in Redis and push for offline users.',
    steps: [
      n('app', 'Mobile app', 0, 220, { text: 'Mobile / web' }),
      n('lb', 'Load balancer', 280, 220, { text: 'L4 load balancer' }),
      e('app', 'lb', { text: 'WebSocket', route: 'ortho' }),
      n('zone', 'Region / VPC', 560, 0, { text: 'us-east-1', w: 1110, h: 520 }),
      n('gw', 'Service', 600, 220, { text: 'Chat gateway', icon: 'message' }),
      e('lb', 'gw'),
      n('presence', 'Cache', 600, 40, { text: 'Presence (Redis)' }),
      e('gw', 'presence', { text: 'heartbeats', dash: 'dashed' }),
      n('log', 'Event stream', 900, 220, { text: 'Messages (Kafka)' }),
      e('gw', 'log', { text: 'publish' }),
      n('fan', 'Worker', 1160, 120, { text: 'Fan-out' }),
      e('log', 'fan'),
      n('store', 'NoSQL store', 1160, 360, { text: 'Message store', h: 110 }),
      e('log', 'store', { text: 'append' }),
      n('push', 'Notifications', 1450, 120, { text: 'Push (APNs/FCM)' }),
      e('fan', 'push', { text: 'offline users', dash: 'dashed' }),
    ],
  },
  {
    id: 'rate-limiter',
    name: 'Rate limiter',
    tag: 'HLD',
    blurb: 'Token buckets enforced at the edge, shared state in Redis, rules pushed from config.',
    steps: [
      n('client', 'Web client', 0, 160, { text: 'Clients' }),
      n('gw', 'API gateway', 300, 160),
      e('client', 'gw'),
      n('rl', 'Rate limiter', 300, 360, { text: 'Limiter middleware' }),
      e('gw', 'rl', { text: 'check(key)' }),
      n('redis', 'Cache', 600, 360, { text: 'Redis token buckets' }),
      e('rl', 'redis', { text: 'EVALSHA' }),
      n('rules', 'Config', 0, 360, { text: 'Rules config' }),
      e('rules', 'rl', { dash: 'dashed', text: 'watch' }),
      n('svc', 'Service', 620, 160, { text: 'Backend services' }),
      e('gw', 'svc', { text: 'allowed' }),
      n('note', 'Note', 620, 0, { text: '429 + Retry-After when the bucket is empty', w: 240, h: 80 }),
    ],
  },
  {
    id: 'parking-lot',
    name: 'Parking lot',
    tag: 'LLD',
    blurb: 'Classic OO design: composition, an abstract spot hierarchy and a pluggable pricing strategy.',
    steps: [
      n('lot', 'Class', 0, 0, { text: 'ParkingLot\n---\n- levels: List<Level>\n---\n+ park(v: Vehicle): Ticket\n+ leave(t: Ticket): Money' }),
      n('level', 'Class', 380, 0, { text: 'Level\n---\n- floor: int\n- spots: List<Spot>\n---\n+ findSpot(v: Vehicle): Spot' }),
      e('lot', 'level', { head: 'none', tail: 'diamondFilled', text: '1..*' }),
      n('spot', 'Abstract class', 760, 0, { text: '*Spot*\n---\n# id: String\n# free: boolean\n---\n+ fits(v: Vehicle): boolean {abstract}' }),
      e('level', 'spot', { head: 'none', tail: 'diamondFilled', text: '1..*' }),
      n('compact', 'Class', 640, 300, { text: 'CompactSpot\n---\n---\n+ fits(v): boolean' }),
      n('large', 'Class', 900, 300, { text: 'LargeSpot\n---\n---\n+ fits(v): boolean' }),
      e('compact', 'spot', { head: 'triangle' }),
      e('large', 'spot', { head: 'triangle' }),
      n('ticket', 'Class', 0, 300, { text: 'Ticket\n---\n- spot: Spot\n- issuedAt: Instant' }),
      e('lot', 'ticket', { head: 'open', dash: 'dashed', text: 'creates' }),
      n('pricing', 'Interface', 380, 300, { text: '«interface»\nPricingStrategy\n---\n+ price(t: Ticket): Money' }),
      e('lot', 'pricing', { head: 'arrow' }),
    ],
  },
  {
    id: 'ecommerce-er',
    name: 'Orders schema',
    tag: 'ER',
    blurb: 'Users, orders, line items and products with crow’s-foot cardinality.',
    steps: [
      n('users', 'ER table', 0, 0, { text: 'users\n---\nid uuid PK\nemail text UQ\ncreated_at timestamptz' }),
      n('orders', 'ER table', 360, 0, { text: 'orders\n---\nid uuid PK\nuser_id uuid FK\nstatus text\ntotal_cents int' }),
      e('users', 'orders', { tail: 'one', head: 'zeroMany' }),
      n('items', 'ER table', 360, 260, { text: 'order_items\n---\norder_id uuid FK\nproduct_id uuid FK\nqty int' }),
      e('orders', 'items', { tail: 'one', head: 'many' }),
      n('products', 'ER table', 720, 260, { text: 'products\n---\nid uuid PK\nsku text UQ\nprice_cents int' }),
      e('products', 'items', { tail: 'one', head: 'zeroMany' }),
    ],
  },
]

/** Builds a template into a fresh editor, one history step per element. */
export function buildTemplate(editor, template) {
  const ids = {}
  let z = 1
  for (const step of template.steps) {
    if (step.kind === 'node') {
      const item = ALL_ITEMS.find((it) => it.name === step.item)
      const el = { ...fitNode(makeNode(item.shape, 0, 0, { ...itemProps(item), ...step.props, z: item.shape === 'zone' ? z++ - 1000 : z++ }), editor.measure), x: step.x, y: step.y }
      ids[step.key] = el.id
      editor.store.set(el.id, el, 'add ' + item.shape)
    } else {
      const edge = makeEdge({ id: ids[step.from] }, { id: ids[step.to] }, { z: z++, ...step.props })
      editor.store.set(edge.id, edge, 'connect')
    }
  }
}
