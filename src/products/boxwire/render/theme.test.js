import { describe, expect, it } from 'vitest'
import { THEMES, colorOf, paintOf } from './theme.js'
import { iconPath } from './icons.js'

describe('palette and icon lookups (regression: inherited names crashed the renderer)', () => {
  it('falls back to ink for unknown or inherited colour tokens', () => {
    for (const t of ['__proto__', 'constructor', 'toString', 'nope', undefined]) {
      expect(colorOf(t, THEMES.light)).toBe(colorOf('ink', THEMES.light))
      expect(() => paintOf({ color: t, fill: 'tint' }, THEMES.dark)).not.toThrow()
    }
  })
  it('returns no icon for unknown or inherited names', () => {
    for (const n of ['__proto__', 'constructor', 'toString', 'nope', undefined]) expect(iconPath(n)).toBeNull()
  })
})
