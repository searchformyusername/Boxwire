// Colours are stored on elements as palette tokens and resolved per theme, so a
// board reads well in light and dark and exports can pick either.

const COLORS = {
  ink: ['#1e1f24', '#e6e7ea'],
  slate: ['#64748b', '#94a3b8'],
  red: ['#e03131', '#ff6b6b'],
  orange: ['#e8590c', '#ff922b'],
  amber: ['#b07c00', '#fcc419'],
  green: ['#2f9e44', '#51cf66'],
  teal: ['#0c8599', '#3bc9db'],
  blue: ['#1c6fd1', '#5aaeff'],
  violet: ['#6f42e0', '#9f85ff'],
  pink: ['#c2255c', '#f783ac'],
}
export const COLOR_NAMES = Object.keys(COLORS)

export const THEMES = {
  light: { name: 'light', paper: '#fbfbfa', dot: 'rgba(30,31,36,0.16)', muted: '#6b7280', accent: '#2563eb', accentSoft: 'rgba(37,99,235,0.12)', accentHover: 'rgba(37,99,235,0.5)', tint: 0.1 },
  dark: { name: 'dark', paper: '#131417', dot: 'rgba(230,231,234,0.13)', muted: '#9097a3', accent: '#5aa2ff', accentSoft: 'rgba(90,162,255,0.16)', accentHover: 'rgba(90,162,255,0.55)', tint: 0.16 },
}

export const colorOf = (token, theme) => (Object.hasOwn(COLORS, token) ? COLORS[token] : COLORS.ink)[theme.name === 'dark' ? 1 : 0]

const rgb = (hex) => {
  const v = parseInt(hex.slice(1), 16)
  return [v >> 16, (v >> 8) & 255, v & 255]
}

/** Opaque blend of `hex` over `base` (tints must hide what is behind them). */
export function mix(hex, base, t) {
  const a = rgb(hex), b = rgb(base)
  return '#' + a.map((v, i) => Math.round(b[i] + (v - b[i]) * t).toString(16).padStart(2, '0')).join('')
}

/**
 * Stroke, fill and text colours for an element.
 * Fill modes: 'paper' (opaque background), 'tint', 'solid', 'none' (transparent).
 */
export function paintOf(el, theme) {
  const c = colorOf(el.color, theme)
  switch (el.fill) {
    case 'solid': return { stroke: c, fill: c, text: theme.paper }
    case 'tint': return { stroke: c, fill: mix(c, theme.paper, theme.tint), text: c }
    case 'none': return { stroke: c, fill: null, text: c }
    default: return { stroke: c, fill: theme.paper, text: c }
  }
}
