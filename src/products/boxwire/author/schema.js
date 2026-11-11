// JSON Schema for the authoring format, built from the same vocabulary the
// compiler uses. public/products/boxwire/schema.json is this object, written
// out; a test fails if the two ever differ. Regenerate with:
//   mise exec node@22.23.2 -- node -e "import('./src/products/boxwire/author/schema.js').then(m => process.stdout.write(JSON.stringify(m.buildSchema(), null, 2) + '\n'))" > public/products/boxwire/schema.json

import {
  CAPACITY_FIELDS, CARRIES, COLORS, DASHES, FILLS, FORMAT, HEADS, ICONS, KEYS, LIMITS, META, NODE_KINDS, RELATIONS, RESERVED_IDS, ROUTES, SIDES, TEXT_SIZES,
  TRUST_LEVELS, UML_KINDS, VERSION,
} from './vocabulary.js'

// The schema is the strict lint for authors: it rejects everything the compiler
// would reject on a single object, and also unknown fields (which the compiler
// only warns about and ignores). Checks that span objects (references, unique
// ids, overlaps, content size after fitting, element totals) are compiler-only.

const enumOf = (values, description) => ({ type: 'string', enum: [...values], ...(description && { description }) })
const coord = { type: 'number', minimum: -LIMITS.coord, maximum: LIMITS.coord }
const size = { type: 'number', minimum: LIMITS.minSize, maximum: LIMITS.maxSize }
const ONE_LINE = '^(?!\\s*-{2,}\\s*$)[^\\n]*$' // no newline, not a "---" compartment separator
const NON_BLANK_LINE = '^(?!\\s*-{2,}\\s*$)(?=[^\\n]*\\S)[^\\n]*$'
const WORD = '^\\S+$'
const umlKinds = Object.keys(UML_KINDS)
const componentKinds = Object.keys(NODE_KINDS).filter((k) => NODE_KINDS[k].shape === 'component')
const META_KEY = `^(?!(?:${RESERVED_IDS.filter((k) => /^[a-z]/.test(k)).join('|')})$)${META.key.source.slice(1, -1)}$`
const kindIn = (kinds) => ({ type: 'object', properties: { kind: { enum: kinds } }, required: ['kind'] })
const forbid = (...keys) => ({ type: 'object', not: { anyOf: keys.map((k) => ({ type: 'object', required: [k] })) } })

export function buildSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://gitreset.dev/products/boxwire/schema.json',
    title: 'Boxwire diagram (authoring format v1)',
    description: 'A diagram an LLM or a person can write by hand. Import it in Boxwire (Boards menu → Open file, or paste it onto the canvas). Guide: https://gitreset.dev/products/boxwire/llm.md. This schema is the strict single-object check; Boxwire additionally checks references, unique ids, content size and element totals, and treats unknown fields as warnings. Source files may also contain // and /* */ comments and trailing commas (JSONC); this schema describes the value once those are removed.',
    type: 'object',
    required: ['format', 'version', 'nodes'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      format: { const: FORMAT },
      version: { const: VERSION },
      name: { type: 'string', maxLength: 120 },
      layout: { enum: ['auto', 'manual'], default: 'auto', description: 'auto: Boxwire places nodes (no x/y allowed). manual: every node needs x and y.' },
      direction: { enum: ['LR', 'TB'], default: 'LR', description: 'Flow direction for auto layout.' },
      nodes: { type: 'array', minItems: 1, maxItems: LIMITS.nodes, items: { $ref: '#/$defs/node' } },
      zones: { type: 'array', maxItems: LIMITS.zones, items: { $ref: '#/$defs/zone' } },
      edges: { type: 'array', maxItems: LIMITS.edges, items: { $ref: '#/$defs/edge' } },
      strokes: { type: 'array', maxItems: LIMITS.strokes, items: { $ref: '#/$defs/stroke' }, description: 'Freehand marks; manual layout only.' },
      frames: { type: 'array', maxItems: LIMITS.frames, items: { $ref: '#/$defs/frame' }, description: 'Presentation slides, in order. Each is drawn around its members.' },
      positions: {
        type: 'object',
        maxProperties: LIMITS.nodes,
        propertyNames: { $ref: '#/$defs/id' },
        additionalProperties: { $ref: '#/$defs/position' },
        description: 'Per-view layout, kept apart from the model: node id → top-left position (and optional size). Auto layout: listed nodes are pinned there after layout. Manual layout: replaces the node\'s own x/y (the node may then omit them). Every key must be a node id.',
      },
    },
    // manual: every node positioned (inline, or through "positions", which only Boxwire can cross-check); auto: no coordinates, no free points, no strokes
    if: { type: 'object', properties: { layout: { const: 'manual' } }, required: ['layout'] },
    then: {
      type: 'object',
      if: { type: 'object', required: ['positions'] },
      else: { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object', required: ['x', 'y'] } } } },
    },
    else: {
      type: 'object',
      properties: {
        nodes: { type: 'array', items: forbid('x', 'y') },
        edges: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
        strokes: { type: 'array', maxItems: 0 },
      },
    },
    $defs: {
      id: {
        type: 'string',
        pattern: `^(?!(?:${RESERVED_IDS.join('|')})$)[A-Za-z][A-Za-z0-9_-]{0,47}$`,
        description: 'Unique across nodes, zones, edges and strokes. Object.prototype names such as "constructor" are reserved.',
      },
      nodeKind: enumOf(Object.keys(NODE_KINDS)),
      relation: enumOf(Object.keys(RELATIONS)),
      color: enumOf(COLORS, 'Colour token; resolved per light/dark theme.'),
      icon: enumOf(ICONS),
      fill: enumOf(FILLS),
      dash: enumOf(DASHES),
      side: enumOf(SIDES),
      route: enumOf(ROUTES),
      head: enumOf(HEADS),
      columnKey: enumOf(KEYS),
      textSize: enumOf(Object.keys(TEXT_SIZES)),
      point: { type: 'object', required: ['x', 'y'], properties: { x: coord, y: coord }, additionalProperties: false },
      position: { type: 'object', required: ['x', 'y'], properties: { x: coord, y: coord, w: size, h: size }, additionalProperties: false },
      trust: enumOf(TRUST_LEVELS, 'Declared trust boundary, from least to most protected.'),
      meta: {
        type: 'object',
        maxProperties: META.maxKeys,
        propertyNames: { type: 'string', pattern: META_KEY },
        additionalProperties: { type: 'string', maxLength: META.maxValue },
        description: 'Free-form declared metadata, such as { "owner": "payments-team", "data": "pii" }. Read by review policies; never inferred from labels.',
      },
      lines: { type: 'array', maxItems: LIMITS.lines, items: { type: 'string', maxLength: 200, pattern: ONE_LINE } },
      column: {
        oneOf: [
          { type: 'string', pattern: `^\\s*\\S{1,80}\\s+\\S{1,80}(?:\\s+(?:${KEYS.join('|')}))?\\s*$`, description: 'Like "id uuid PK".' },
          {
            type: 'object',
            required: ['name', 'type'],
            properties: { name: { type: 'string', maxLength: 80, pattern: WORD }, type: { type: 'string', maxLength: 80, pattern: WORD }, key: { $ref: '#/$defs/columnKey' } },
            additionalProperties: false,
          },
        ],
      },
      node: {
        type: 'object',
        required: ['id', 'kind'],
        properties: {
          id: { $ref: '#/$defs/id' },
          kind: { $ref: '#/$defs/nodeKind' },
          label: { type: 'string', maxLength: LIMITS.label, description: 'Text shown on the node. Not used by class, interface, abstract-class, enum or table.' },
          name: { type: 'string', maxLength: 200, pattern: NON_BLANK_LINE, description: 'UML or table name.' },
          stereotype: { type: 'string', maxLength: 60, pattern: ONE_LINE },
          abstract: { type: 'boolean' },
          attributes: { $ref: '#/$defs/lines' },
          methods: { $ref: '#/$defs/lines' },
          values: { $ref: '#/$defs/lines', description: 'Enum constants (kind "enum" only).' },
          columns: { type: 'array', minItems: 1, maxItems: LIMITS.lines, items: { $ref: '#/$defs/column' } },
          x: coord, y: coord, w: size, h: size,
          rank: { type: 'integer', minimum: 0, maximum: 100, description: 'Auto layout only: the earliest column (LR) or row (TB) this node may sit in, 0 being the first. Use it for nodes nothing points at, such as a batch job, that would otherwise land in the first column.' },
          color: { $ref: '#/$defs/color' },
          fill: { $ref: '#/$defs/fill' },
          dash: { $ref: '#/$defs/dash' },
          crossed: { type: 'boolean', description: 'Draw a red cross: a rejected option.' },
          icon: { $ref: '#/$defs/icon', description: 'Component kinds only.' },
          textSize: { $ref: '#/$defs/textSize' },
          font: { enum: ['sans', 'mono'] },
          align: { enum: ['left', 'center', 'right'] },
          capacity: { $ref: '#/$defs/capacity' },
          meta: { $ref: '#/$defs/meta' },
        },
        additionalProperties: false,
        allOf: [
          { if: kindIn(umlKinds), then: { ...forbid('label', 'columns'), required: ['name'] }, else: forbid('stereotype', 'abstract', 'attributes', 'methods', 'values') },
          { if: kindIn(['enum']), then: forbid('attributes', 'methods'), else: forbid('values') },
          { if: kindIn(['abstract-class']), then: { type: 'object', properties: { abstract: { const: true } } } },
          { if: kindIn(['table']), then: { ...forbid('label'), required: ['name', 'columns'], properties: { name: { type: 'string', pattern: WORD } } }, else: forbid('columns') },
          { if: { type: 'object', not: kindIn([...umlKinds, 'table']) }, then: forbid('name') },
          { if: kindIn(['text']), then: { type: 'object', required: ['label'], properties: { label: { type: 'string', pattern: '\\S' } } } },
          { if: { type: 'object', not: kindIn(componentKinds) }, then: forbid('icon') },
        ],
      },
      zone: {
        type: 'object',
        required: ['id', 'contains'],
        properties: {
          id: { $ref: '#/$defs/id' },
          label: { type: 'string', maxLength: 200 },
          contains: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Node ids; the zone is drawn around them.' },
          color: { $ref: '#/$defs/color' },
          trust: { $ref: '#/$defs/trust' },
          padding: { type: 'number', minimum: 8, maximum: 200, default: 32 },
        },
        additionalProperties: false,
      },
      edge: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          id: { $ref: '#/$defs/id' },
          from: { oneOf: [{ type: 'string', description: 'Node or zone id.' }, { $ref: '#/$defs/point' }] },
          to: { oneOf: [{ type: 'string', description: 'Node or zone id.' }, { $ref: '#/$defs/point' }] },
          kind: { $ref: '#/$defs/relation', default: 'flow' },
          label: { type: 'string', maxLength: LIMITS.label },
          fromSide: { $ref: '#/$defs/side' },
          toSide: { $ref: '#/$defs/side' },
          route: { $ref: '#/$defs/route', default: 'ortho' },
          head: { $ref: '#/$defs/head' },
          tail: { $ref: '#/$defs/head' },
          dash: { $ref: '#/$defs/dash' },
          color: { $ref: '#/$defs/color' },
          width: { type: 'number', minimum: 0.5, maximum: 8 },
          carries: { enum: [...CARRIES], description: 'For capacity: only reads, only writes, or "lookups" (one read per request the source handles). Omit for everything the source sends on.' },
          share: { type: 'number', minimum: 0, maximum: 1, description: 'For capacity: the fraction of the source\'s output this edge carries (default 1).' },
        },
        additionalProperties: false,
        allOf: [
          { if: { type: 'object', properties: { from: { type: 'object' } } }, then: forbid('fromSide') },
          { if: { type: 'object', properties: { to: { type: 'object' } } }, then: forbid('toSide') },
        ],
      },
      capacity: {
        type: 'object',
        description: 'Declared capacity facts and declarations read by Boxwire\'s review (lint, capacity, rubric). Undeclared means unknown. See "Capacity" in the guide.',
        properties: Object.fromEntries(Object.entries(CAPACITY_FIELDS).map(([k, f]) => [k, f.type === 'boolean'
          ? { type: 'boolean', description: f.label }
          : { type: f.integer ? 'integer' : 'number', minimum: f.min, maximum: f.max, description: `${f.label} (${f.unit})` }])),
        additionalProperties: false,
      },
      frame: {
        type: 'object',
        required: ['id', 'contains'],
        properties: {
          id: { $ref: '#/$defs/id' },
          label: { type: 'string', maxLength: 200 },
          contains: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Node or zone ids; the frame is drawn around them.' },
          padding: { type: 'number', minimum: 8, maximum: 400, default: 40 },
        },
        additionalProperties: false,
      },
      stroke: {
        type: 'object',
        required: ['points'],
        properties: {
          id: { $ref: '#/$defs/id' },
          points: { type: 'array', minItems: 2, maxItems: LIMITS.points, items: { type: 'array', prefixItems: [coord, coord], minItems: 2, maxItems: 2 } },
          color: { $ref: '#/$defs/color' },
          width: { type: 'number', minimum: 1, maximum: 20 },
          highlighter: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }
}
