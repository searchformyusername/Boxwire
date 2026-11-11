# Extraction notes

Copied from `searchformyusername/gitreset.dev` at commit `6c9a783c600e6fbb45c5abdc4946b98470170e63` on November 11, 2026. The original checkout was left unchanged.

The copy contains Boxwire's source, fixtures, public guide, schema, examples and checks. It has its own Vite entry point, package manifest and lockfile. The compiler's shared Levenshtein helper was copied without the terminal's other suggestion functions. Browser checks use a local CDP helper. No other product source or local package links are included.

The editor opens at `/`; the original `/products/boxwire` path also works through the SPA fallback. The product-list back link was removed. Existing schema identifiers and export attribution were preserved.

Verified from this repository using Node 22.23.2 and Chrome 157:

- 977 tests across 41 files passed, including routing, source sync, import/export, review, history and autosave checks.
- Lint and the production build passed.
- The browser gate passed mobile accessible names, mouse and keyboard merge workflows, and source-header acceptance checks.
- All nine native IndexedDB checks passed, including transaction rollback and autosave retry.
- The production smoke check passed drawing, undo/redo, imports, board/PNG/SVG/PDF downloads, review, save/reload, theme persistence and timelapse playback.
- The 1,400-node change-review performance gate passed its 500 ms repeat-review budget.
- All 16 published examples compiled and reviewed identically to the source checkout, and produced identical SVG with deterministic text measurement.

Browser checks use disposable profiles. They do not migrate boards saved on another origin. Use board file export/import to transfer those.
