import { useMemo, useState } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'
import { searchItems } from '../catalog.js'
import Modal from './Modal.jsx'

/** ⌘K: type a component name and press Enter to drop it at the pointer; also runs commands. */
export default function Palette({ commands, onInsert, onClose }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo(() => {
    const query = q.trim().toLowerCase()
    const cmds = commands.filter((c) => !query || c.name.toLowerCase().includes(query)).map((c) => ({ kind: 'command', ...c }))
    const items = searchItems(q).slice(0, query ? 30 : 12).map((it) => ({ kind: 'item', name: it.name, hint: it.group, item: it }))
    return query ? [...items, ...cmds] : [...items, ...cmds.slice(0, 8)]
  }, [q, commands])

  const run = (r) => {
    if (!r) return
    onClose()
    if (r.kind === 'item') onInsert(r.item)
    else r.run()
  }

  const onKeyDown = (e) => {
    e.stopPropagation()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[active])
    }
  }

  return (
    <Modal className="bw-palette" label="Insert component or run command" onClose={onClose}>
      <div className="bw-search bw-palette-search">
        <Search size={17} />
        <input
          autoFocus
          value={q}
          placeholder="Insert “kafka”, “load balancer”, “class”… or run a command"
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          aria-label="Search"
          aria-activedescendant={`bw-pal-${active}`}
          aria-controls="bw-pal-list"
        />
      </div>
      <ul id="bw-pal-list" className="bw-palette-list" role="listbox">
        {results.map((r, i) => (
          <li
            key={r.kind + r.name}
            id={`bw-pal-${i}`}
            role="option"
            aria-selected={i === active}
            className={i === active ? 'is-active' : ''}
            onPointerMove={() => setActive(i)}
            onClick={() => run(r)}
          >
            <span>{r.name}</span>
            <span className="bw-palette-hint">{r.kind === 'command' ? r.hint ?? 'Command' : r.hint}</span>
            {i === active && <CornerDownLeft size={14} />}
          </li>
        ))}
        {!results.length && <li className="bw-palette-empty">Nothing matches. Try “service”, “db”, “queue”.</li>}
      </ul>
    </Modal>
  )
}
