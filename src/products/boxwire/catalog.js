// The component library: named presets over the base shapes. Searchable from
// the library panel and the ⌘K palette. `kind` is the stable public name used
// by the authoring format (author/) — never rename one, only add.

const c = (name, icon, color = 'ink', extra = {}) => ({ name, shape: 'component', icon, color, text: name, ...extra })

export const LIBRARY = [
  {
    group: 'Clients & edge',
    items: [
      c('Web client', 'monitor', 'ink', { kind: 'web-client', keywords: 'browser frontend spa' }),
      c('Mobile app', 'phone', 'ink', { kind: 'mobile-app', keywords: 'ios android' }),
      { name: 'User', kind: 'user', shape: 'actor', text: 'User', keywords: 'person actor customer' },
      c('DNS', 'globe', 'teal', { kind: 'dns', keywords: 'route53 domain' }),
      c('CDN', 'earth', 'teal', { kind: 'cdn', keywords: 'cloudfront edge cache static' }),
      c('Load balancer', 'split', 'violet', { kind: 'load-balancer', keywords: 'lb alb nginx haproxy' }),
      c('API gateway', 'door', 'violet', { kind: 'api-gateway', keywords: 'gateway ingress edge' }),
      c('Rate limiter', 'gauge', 'orange', { kind: 'rate-limiter', keywords: 'throttle token bucket' }),
      c('Auth service', 'key', 'amber', { kind: 'auth-service', keywords: 'identity oauth sso idp login' }),
    ],
  },
  {
    group: 'Compute',
    items: [
      c('Service', 'server', 'blue', { kind: 'service', keywords: 'microservice api backend app server' }),
      c('Worker', 'cpu', 'blue', { kind: 'worker', keywords: 'consumer job background' }),
      c('Serverless fn', 'zap', 'orange', { kind: 'serverless-function', keywords: 'lambda function faas' }),
      c('Scheduler', 'clock', 'slate', { kind: 'scheduler', keywords: 'cron job timer' }),
      c('LLM inference', 'sparkles', 'violet', { kind: 'llm-inference', keywords: 'model gpu ai vllm' }),
      c('Agent', 'bot', 'violet', { kind: 'agent', keywords: 'ai agent tool use' }),
      c('Container', 'container', 'blue', { kind: 'container', keywords: 'docker kubernetes pod k8s' }),
    ],
  },
  {
    group: 'Data',
    items: [
      { name: 'SQL database', kind: 'sql-database', shape: 'cylinder', text: 'PostgreSQL', color: 'blue', keywords: 'postgres mysql rdbms db sql' },
      { name: 'NoSQL store', kind: 'nosql-store', shape: 'cylinder', text: 'NoSQL', color: 'green', keywords: 'dynamodb cassandra mongo kv key-value' },
      c('Cache', 'zap', 'red', { kind: 'cache', text: 'Redis cache', keywords: 'redis memcached' }),
      c('Object storage', 'archive', 'amber', { kind: 'object-storage', text: 'Object storage', keywords: 's3 blob gcs bucket files' }),
      c('Search index', 'search', 'teal', { kind: 'search-index', keywords: 'elasticsearch opensearch lucene' }),
      { name: 'Vector DB', kind: 'vector-db', shape: 'cylinder', text: 'Vector DB', color: 'violet', keywords: 'embeddings pgvector pinecone rag' },
      { name: 'Data warehouse', kind: 'data-warehouse', shape: 'cylinder', text: 'Warehouse', color: 'slate', keywords: 'snowflake bigquery olap analytics' },
    ],
  },
  {
    group: 'Messaging',
    items: [
      { name: 'Message queue', kind: 'message-queue', shape: 'queue', text: 'Queue', color: 'orange', keywords: 'sqs rabbitmq mq' },
      { name: 'Event stream', kind: 'event-stream', shape: 'queue', text: 'Kafka topic', color: 'ink', keywords: 'kafka kinesis log stream' },
      c('Pub/Sub', 'radio', 'orange', { kind: 'pub-sub', keywords: 'sns fanout topic broadcast' }),
      c('Notifications', 'bell', 'pink', { kind: 'notifications', keywords: 'push apns fcm' }),
      c('Email / SMS', 'mail', 'pink', { kind: 'email-sms', keywords: 'ses twilio' }),
      c('Webhook', 'webhook', 'slate', { kind: 'webhook', keywords: 'callback' }),
    ],
  },
  {
    group: 'Infra & ops',
    items: [
      { name: 'Region / VPC', kind: 'region', shape: 'zone', text: 'us-east-1', keywords: 'zone boundary network frame group az' },
      c('Monitoring', 'activity', 'green', { kind: 'monitoring', keywords: 'metrics prometheus grafana observability' }),
      c('Logs', 'file', 'slate', { kind: 'logs', keywords: 'logging elk splunk' }),
      c('Analytics', 'chart', 'green', { kind: 'analytics', keywords: 'dashboard bi' }),
      { name: 'External API', kind: 'external-api', shape: 'cloud', text: '3rd-party API', color: 'slate', keywords: 'internet external saas' },
      c('Payments', 'card', 'green', { kind: 'payments', keywords: 'stripe billing psp' }),
      c('Config', 'cog', 'slate', { kind: 'config', keywords: 'feature flags settings' }),
    ],
  },
  {
    group: 'LLD & data model',
    items: [
      { name: 'Class', kind: 'class', shape: 'class', text: 'ClassName\n---\n- id: String\n---\n+ method(): void', keywords: 'uml object' },
      { name: 'Interface', kind: 'interface', shape: 'class', text: '«interface»\nShape\n---\n+ area(): double', keywords: 'uml contract' },
      { name: 'Abstract class', kind: 'abstract-class', shape: 'class', text: '*Vehicle*\n---\n# plate: String\n---\n+ wheels(): int {abstract}', keywords: 'uml base' },
      { name: 'Enum', kind: 'enum', shape: 'class', text: '«enum»\nStatus\n---\nACTIVE\nSUSPENDED', keywords: 'uml enumeration' },
      { name: 'ER table', kind: 'table', shape: 'table', text: 'users\n---\nid uuid PK\nemail text UQ\ncreated_at timestamptz', keywords: 'entity schema sql relation erd' },
      { name: 'Package', kind: 'package', shape: 'zone', text: 'package', keywords: 'module namespace boundary' },
      { name: 'Note', kind: 'note', shape: 'note', text: '', keywords: 'sticky comment' },
    ],
  },
  {
    group: 'Basic shapes',
    items: [
      { name: 'Box', kind: 'box', shape: 'rect', text: '' },
      { name: 'Ellipse', kind: 'ellipse', shape: 'ellipse', text: '', keywords: 'circle oval start end' },
      { name: 'Decision', kind: 'decision', shape: 'diamond', text: '', keywords: 'diamond if branch' },
      { name: 'Hexagon', kind: 'hexagon', shape: 'hexagon', text: '', keywords: 'service' },
      { name: 'Cylinder', kind: 'cylinder', shape: 'cylinder', text: '', keywords: 'database storage' },
      { name: 'Queue shape', kind: 'queue-shape', shape: 'queue', text: '' },
      { name: 'Cloud', kind: 'cloud', shape: 'cloud', text: '' },
      { name: 'Text', kind: 'text', shape: 'text', text: '', keywords: 'label title' },
      { name: 'Frame (slide)', kind: 'frame', shape: 'frame', text: 'Frame', keywords: 'slide present presentation walkthrough pdf page' },
    ],
  },
]

export const ALL_ITEMS = LIBRARY.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })))

/** Rank items for a query: name prefix > word prefix > substring > keyword. */
export function searchItems(query) {
  const q = query.trim().toLowerCase()
  if (!q) return ALL_ITEMS
  const score = (it) => {
    const name = it.name.toLowerCase()
    if (name.startsWith(q)) return 4
    if (name.split(/[\s/]+/).some((w) => w.startsWith(q))) return 3
    if (name.includes(q) || (it.text || '').toLowerCase().includes(q)) return 2
    return (it.keywords || '').split(' ').some((k) => k.startsWith(q)) ? 1 : 0
  }
  return ALL_ITEMS.map((it) => [score(it), it]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, it]) => it)
}

/** Element props for inserting a library item. `kind` is the semantic type the review engine reads (review/graph.js). */
export const itemProps = ({ kind, text = '', icon, color, fill }) => ({ ...(kind && { kind }), text, ...(icon && { icon }), ...(color && { color }), ...(fill && { fill }) })
