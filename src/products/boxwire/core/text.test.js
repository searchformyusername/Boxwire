import { describe, expect, it } from 'vitest'
import { splitSections, wrapText } from './text.js'
import { createSnapper } from './snap.js'

const mono = (s) => Array.from(s).length // 1 unit per code point

describe('wrapText', () => {
  it('breaks an overlong first token (regression)', () => {
    expect(wrapText('abcdefghijklmnop', 5, 'f', mono)).toEqual(['abcde', 'fghij', 'klmno', 'p'])
  })

  it('breaks overlong tokens mid-paragraph and keeps every character', () => {
    const text = 'call AbstractSingletonProxyFactoryBean now'
    const lines = wrapText(text, 10, 'f', mono)
    expect(lines.every((l) => mono(l) <= 10)).toBe(true)
    expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })

  it('wraps on words and keeps explicit newlines', () => {
    expect(wrapText('load balancer\nL7', 8, 'f', mono)).toEqual(['load', 'balancer', 'L7'])
  })

  it('never splits a grapheme', () => {
    const lines = wrapText('👩‍💻👩‍💻👩‍💻', 6, 'f', (s) => Array.from(s).length)
    expect(lines.join('')).toBe('👩‍💻👩‍💻👩‍💻')
    for (const l of lines) expect(l.length % '👩‍💻'.length).toBe(0)
  })

  it('handles empty text', () => {
    expect(wrapText('', 10, 'f', mono)).toEqual([''])
  })
})

describe('splitSections', () => {
  it('splits UML compartments on dashed lines', () => {
    expect(splitSections('A\n---\n- x: int\n---\n+ f()')).toEqual([['A'], ['- x: int'], ['+ f()']])
  })

  it('keeps empty compartments between consecutive separators', () => {
    expect(splitSections('CompactSpot\n---\n---\n+ fits(v)')).toEqual([['CompactSpot'], [], ['+ fits(v)']])
    expect(splitSections('Only')).toEqual([['Only']])
  })
})

describe('snapper', () => {
  it('prefers an exact alignment (0) over later near matches (regression)', () => {
    const s = createSnapper([{ x: 0, y: 0, w: 100, h: 100 }])
    const r = s.move({ x: 0, y: 0, w: 49, h: 49 }, 2)
    expect(r.dx).toBe(0)
    expect(r.dy).toBe(0)
    expect(r.guides.length).toBeGreaterThan(0)
  })

  it('snaps edges and centres within tolerance and draws a guide', () => {
    const s = createSnapper([{ x: 200, y: 0, w: 100, h: 50 }])
    const r = s.move({ x: 203, y: 300, w: 100, h: 50 }, 6)
    expect(r.dx).toBe(-3)
    expect(r.guides.some((g) => g.x1 === 200 && g.x2 === 200)).toBe(true)
    expect(s.move({ x: 230, y: 300, w: 10, h: 10 }, 6).dx).toBe(0)
  })
})
