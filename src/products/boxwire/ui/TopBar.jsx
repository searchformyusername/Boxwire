import {
  Bot, ChevronDown, CircleHelp, ClipboardCopy, CloudCheck, CloudOff, Download, FileCode, FileJson, FilePlus, FileText, Film, FolderOpen,
  Gauge, GitCompare, Image, LayoutTemplate, LoaderCircle, Moon, Play, Presentation, Redo2, Sun, Timer, Trash2, Undo2, Upload,
} from 'lucide-react'
import { reviewDoc } from '../review/index.js'
import Menu, { MenuItem } from './Menu.jsx'
import { useEditor } from './useEditor.js'

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(t).toLocaleDateString()
}

function SaveBadge({ save, onDownload }) {
  if (save.status === 'error') {
    return (
      <button type="button" className="bw-save is-error" onClick={onDownload} title={`${save.message} Click to download a backup file.`}>
        <CloudOff size={14} /> Not saved — download backup
      </button>
    )
  }
  const saving = save.status === 'saving' || save.status === 'dirty'
  return (
    <span className="bw-save" role="status" aria-live="polite">
      {saving ? <LoaderCircle size={14} className="bw-spin" /> : <CloudCheck size={14} />}
      <span className="bw-save-text">{saving ? 'Saving…' : save.status === 'saved' ? 'Saved on this device' : ''}</span>
    </span>
  )
}

export default function TopBar({ editor, meta, boards, save, actions, reviewOpen, hasSource }) {
  const { canUndo, canRedo, theme, steps, hasSelection, violations } = useEditor(editor, (ed) => ({
    violations: reviewDoc(ed.store.committedDoc).violations.length,
    hasSelection: ed.ui.selection.length > 0,
    canUndo: ed.store.history.done.length > 0,
    canRedo: ed.store.history.undone.length > 0,
    theme: ed.ui.theme,
    steps: ed.store.history.done.length,
  }))

  return (
    <>
      <header className="bw-panel bw-topbar bw-topbar-left">
        <span className="bw-wordmark" aria-hidden="true">
          <span className="bw-logo" />
          Boxwire
        </span>
        <input
          className="bw-name"
          aria-label="Board name"
          value={meta.name}
          maxLength={120}
          onChange={(e) => actions.rename(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <Menu icon={<ChevronDown size={15} />} title="Boards" className="bw-boards">
          <MenuItem icon={<FilePlus size={15} />} onClick={() => actions.newBoard()}>New blank board</MenuItem>
          <MenuItem icon={<LayoutTemplate size={15} />} onClick={actions.openTemplates}>New from template…</MenuItem>
          <MenuItem icon={<Timer size={15} />} onClick={actions.openPractice}>Practice an interview problem…</MenuItem>
          <MenuItem icon={<Upload size={15} />} onClick={actions.importFile}>Open file (board, diagram, patch or review bundle)…</MenuItem>
          <MenuItem icon={<GitCompare size={15} />} onClick={actions.openChangeReview}>Review an architecture change…</MenuItem>
          {hasSource && <MenuItem icon={<FileCode size={15} />} onClick={actions.toggleSource}>Source file of this board</MenuItem>}
          <MenuItem icon={<Bot size={15} />} onClick={actions.openGuide}>Have an AI draw it: format guide</MenuItem>
          {boards.filter((b) => b.id !== meta.id).length > 0 && <div className="bw-menu-sep">Recent boards</div>}
          {boards.filter((b) => b.id !== meta.id).slice(0, 12).map((b) => (
            <MenuItem key={b.id} icon={<FolderOpen size={15} />} hint={ago(b.updatedAt)} onClick={() => actions.openBoard(b.id)}>
              {b.name}
            </MenuItem>
          ))}
          <div className="bw-menu-sep" />
          <MenuItem icon={<Trash2 size={15} />} danger onClick={actions.deleteBoard}>Delete this board</MenuItem>
        </Menu>
        <SaveBadge save={save} onDownload={actions.exportJson} />
      </header>

      <div className="bw-panel bw-topbar bw-topbar-right">
        <button type="button" className="bw-icon-btn" aria-label="Undo (⌘Z)" title="Undo · ⌘Z" disabled={!canUndo} onClick={() => editor.undo()}>
          <Undo2 size={17} />
        </button>
        <button type="button" className="bw-icon-btn" aria-label="Redo (⇧⌘Z)" title="Redo · ⇧⌘Z" disabled={!canRedo} onClick={() => editor.redo()}>
          <Redo2 size={17} />
        </button>
        <span className="bw-divider" />
        <button type="button" className={`bw-btn${reviewOpen ? ' is-on' : ''}`} aria-pressed={reviewOpen} aria-label={`Review${violations > 0 ? `, ${violations} violations` : ''}`} onClick={actions.toggleReview} title="Architecture lint, capacity and the rubric score">
          <Gauge size={15} /> <span className="bw-btn-label">Review</span>
          {violations > 0 && <span className="bw-badge" aria-label={`${violations} violations`}>{violations}</span>}
        </button>
        <button type="button" className="bw-icon-btn" aria-label="Present frames" title="Present: walk through frames with the arrow keys" onClick={() => actions.present(0)} disabled={!steps}>
          <Presentation size={17} />
        </button>
        <button type="button" className="bw-btn bw-btn-accent" aria-label="Timelapse" onClick={() => actions.openReplay()} disabled={!steps} title="Watch how this diagram was built, then export it as a GIF or video">
          <Play size={15} /> <span className="bw-btn-label">Timelapse</span>
        </button>
        <Menu icon={<Download size={16} />} label="Export" align="right">
          <MenuItem icon={<Image size={15} />} hint="⇧⌘E" onClick={() => actions.exportPng()}>PNG image (2×)</MenuItem>
          <MenuItem icon={<Image size={15} />} onClick={() => actions.exportPng({ background: false })}>PNG, transparent</MenuItem>
          <MenuItem icon={<Image size={15} />} onClick={() => actions.exportPng({ selectionOnly: true })} disabled={!hasSelection}>PNG of selection</MenuItem>
          <MenuItem icon={<ClipboardCopy size={15} />} onClick={actions.copyPng}>Copy image to clipboard</MenuItem>
          <MenuItem icon={<FileCode size={15} />} onClick={() => actions.exportSvg()}>SVG (vector)</MenuItem>
          <MenuItem icon={<FileCode size={15} />} onClick={() => actions.exportSvg({ selectionOnly: true })} disabled={!hasSelection}>SVG of selection</MenuItem>
          <MenuItem icon={<FileText size={15} />} onClick={actions.exportPdf}>PDF, one page per frame</MenuItem>
          <div className="bw-menu-sep" />
          <MenuItem icon={<Film size={15} />} onClick={() => actions.openReplay()} disabled={!steps}>Timelapse GIF / video…</MenuItem>
          <MenuItem icon={<FileJson size={15} />} onClick={actions.exportJson}>Board file (.boxwire.json)</MenuItem>
          <MenuItem icon={<Bot size={15} />} onClick={actions.exportCritique}>Critique bundle for an AI agent</MenuItem>
        </Menu>
        <span className="bw-divider" />
        <button type="button" className="bw-icon-btn" aria-label="Keyboard shortcuts (?)" title="Shortcuts · ?" onClick={actions.openHelp}>
          <CircleHelp size={17} />
        </button>
        <button type="button" className="bw-icon-btn" aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'} title="Toggle theme" onClick={actions.toggleTheme}>
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </div>
    </>
  )
}
