// The public vocabulary of the authoring format. Node kinds come straight from
// the component catalog (one source for the library, ⌘K and authored files);
// relations are fixed bundles of arrowheads and dash.

import { ALL_ITEMS } from '../catalog.js'
import { COLOR_NAMES } from '../render/theme.js'
import { ICON_NAMES } from '../render/icons.js'

export const FORMAT = 'boxwire-diagram'
export const VERSION = 1

/** Kinds whose catalog item is a zone are expressed through `zones`, and frames through `frames`, not `nodes`. */
export const NODE_KINDS = Object.fromEntries(ALL_ITEMS.filter((it) => it.shape !== 'zone' && it.shape !== 'frame').map((it) => [it.kind, it]))
export const ZONE_KINDS = ALL_ITEMS.filter((it) => it.shape === 'zone').map((it) => it.kind)

export { CAPACITY_FIELDS, CARRIES, META, TRUST_LEVELS } from '../core/declared.js'

export const UML_KINDS = { class: {}, interface: { stereotype: 'interface' }, 'abstract-class': { abstract: true }, enum: { stereotype: 'enum' } }

export const RELATIONS = {
  flow: { head: 'arrow', tail: 'none', dash: 'solid' },
  async: { head: 'arrow', tail: 'none', dash: 'dashed' },
  'two-way': { head: 'arrow', tail: 'arrow', dash: 'solid' },
  dependency: { head: 'open', tail: 'none', dash: 'dashed' },
  association: { head: 'open', tail: 'none', dash: 'solid' },
  inheritance: { head: 'triangle', tail: 'none', dash: 'solid' },
  realization: { head: 'triangle', tail: 'none', dash: 'dashed' },
  aggregation: { head: 'none', tail: 'diamond', dash: 'solid' },
  composition: { head: 'none', tail: 'diamondFilled', dash: 'solid' },
  'one-to-one': { head: 'one', tail: 'one', dash: 'solid' },
  'one-to-many': { head: 'many', tail: 'one', dash: 'solid' },
  'zero-or-many': { head: 'zeroMany', tail: 'one', dash: 'solid' },
  'many-to-many': { head: 'many', tail: 'many', dash: 'solid' },
  line: { head: 'none', tail: 'none', dash: 'solid' },
}
/** Relations whose arrow points child → parent; auto layout puts the parent first. */
export const PARENT_POINTING = new Set(['inheritance', 'realization'])

export const COLORS = COLOR_NAMES
export const ICONS = ICON_NAMES
export const FILLS = ['paper', 'tint', 'solid', 'none']
export const DASHES = ['solid', 'dashed', 'dotted']
export const SIDES = ['n', 'e', 's', 'w']
export const ROUTES = ['ortho', 'curve', 'straight']
export const HEADS = ['none', 'arrow', 'open', 'triangle', 'diamond', 'diamondFilled', 'circle', 'one', 'many', 'oneMany', 'zeroMany']
export const KEYS = ['PK', 'FK', 'UQ', 'PK FK']
export const TEXT_SIZES = { s: 13, m: 16, l: 20, xl: 28 }

export const LIMITS = {
  bytes: 5 * 1024 * 1024,
  nodes: 1500,
  edges: 3000,
  zones: 200,
  frames: 100,
  strokes: 500,
  points: 5000,
  label: 2000,
  lines: 200,
  coord: 1e5,
  strokeSpan: 1e5,
  minSize: 16,
  maxSize: 4000,
}

export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/
/** Object.prototype member names that fit ID_PATTERN; they'd alias prototype members in the document map. */
export const RESERVED_IDS = Object.getOwnPropertyNames(Object.prototype).filter((k) => ID_PATTERN.test(k)).sort()
/** Longest value we try to match against the vocabulary or echo back in a message. */
export const MAX_ECHO = 64
