# Changelog

All notable changes to the SpecPress Extension for VS Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.9] - 2026-07-27

### Added

- **SpecPress update** - Inherit latest SpecPress library version to get support for image-width statement, e.g. `![alt](image.png =50%x)` — display at 50% of the page/body width

## [0.7.8] - 2026-07-27

### Changed

- **Smoother Scroll-Sync** - Improved scroll sync to run smoothly and to open adjacent source files (MD/ASN) when the preview moves therein.

## [0.7.7] - 2026-07-24

### Changed

- **CSS colors** - Adjusted colors for HTML DIFF view
- **SpecPress update** - Enforce latest SpecPress library

## [0.7.6] - 2026-07-22

### Added

- **MSC-Gen diagram support** — MSC-Gen sequence, block, and graph diagrams (fenced `mscgen` code blocks) are now rendered in the live preview, multi-file preview, HTML export, and DOCX export. Requires the [msc-generator](https://gitlab.com/msc-generator/msc-generator) CLI tool. A warning is shown if it is not installed.
- **HTML export from Explorer context menu** — "Export Selected to HTML" is now available directly from the Explorer pane (right-click on files/folders), mirroring the DOCX export workflow. Supports version selection and optional HTML diff export between two git versions (insertions/deletions highlighted inline, filename encodes both hashes e.g. `...DIFF_abc1234_vs_def5678.html`).
- **`mermaidWebviewRenderer.js`** — Extracted VS Code webview-based mermaid renderer into its own module, sharing `buildMermaidPageScript()` from specpress for consistent render logic between the webview and headless browser paths.
- **`pickVersions()` helper** — Unified version picker used by both HTML and DOCX export. Prompts for a base version and up to N additional versions, with optional author name input for each transition (used by DOCX diff).
- **`warnIfMscgenMissing()` helper** — Shows a VS Code warning with an install link if msc-gen is not found before HTML or DOCX export.

### Changed

- **`exportHtml` command** — Completely rewritten to delegate all file I/O and rendering to specpress's new `exportHtml()` library function. The command now works from the Explorer context menu (selected files/folders) rather than from the preview panel.
- **`diffRenderer.js`** — Simplified significantly: the word-level HTML diff logic is now delegated to specpress's `diffHtml()` function. Baseline file access uses `FileResolver` instead of a flat in-memory map.
- **`previewManager.js`** — Refactored to use `FileResolver` for all file access in both single-file and multi-file preview. The webview panel is recreated only when `localResourceRoots` need to change (e.g. when change tracking is toggled), avoiding unnecessary focus disruption.
- **`multiFilePreviewBuilder.js`** — Refactored to use `FileResolver` for git-commit image resolution (replaces the old `extractFilesFromCommit` + base64 data URI approach). Multi-file preview now also supports HTML diff between two versions.
- **`exportDocx.js`** — Refactored: single-version and multi-version (diff) export are now separate internal functions. Uses `FileResolver` for git-commit file access. DOCX diff version/author selection is now handled by the shared `pickVersions()` helper. LibreOffice is now supported as a merge backend (cross-platform, no MS Word required).
- **`makeMermaidRenderer()`** — Updated to use `renderMermaidCached` from `specpress/lib/common/diagramRenderers` and `renderMermaidViaWebview` from the new local `mermaidWebviewRenderer.js` module.
- **Removed obsolete files** — `src/vscode/compareDocx.js` and `src/vscode/crCoverPageHelper.js` deleted (logic moved to specpress or consolidated into other modules).
- **All specpress imports consolidated to `require('specpress')`** — All 14 source files previously importing via direct paths (e.g. `require('specpress/lib/common/...')`) now import exclusively through the package entry point, in line with specpress restricting its public API to `lib/index.js`.
- Updated to specpress 3.3.4.

### Fixed

- **Change tracking scroll sync** — Fixed scroll sync breaking when change tracking was enabled.
- **vscode-resource URIs in HTML export** — Fixed webview-specific URIs leaking into exported HTML files.
- **Double front page in export** — Fixed front page being injected twice in certain export paths.

## [0.7.5] - 2026-07-02

### Added

- **Section number decorations** - When `specpress.deriveSectionNumbers` is enabled, files and folders inside `specificationRootPath` show their derived section number and heading as a tooltip in the Explorer pane
- **Outline view with resolved headings** - The VS Code Outline panel shows resolved section headings (e.g. `3.2 Abbreviations`) instead of raw x-placeholders (e.g. `x.x Abbreviations`) for files inside the spec root
- **Hover tooltips for section headings** - Hovering over a heading line containing an x-placeholder in the markdown editor shows the resolved section heading (e.g. `§ 3.2 Abbreviations`)
- **Hover tooltips for figure/table captions** - Hovering over a `Figure x.x-1:` or `Table x.x-1:` caption line shows the resolved caption with the derived section number

## [0.7.4] - 2025-07-02

### Added

- **Band Combinations** - Dedicated side pane for browsing, filtering, validating, and previewing RAN4 band combination data (TS 38.101)
  - Tree view listing all band combinations sorted by BC-ID
  - Rich filter pane: band numbers (Any of / At Least / Only), number of carriers, number of bands, properties (Intra/Inter, FR1/FR2, Contiguous/Non-contiguous, NR only, SUL), UL/DL notes, git-modified status
  - Run schema and content validation with results written to a log file
  - Right-click a JSON file to normalize it (canonical key ordering, consistent formatting)

### Changed

- Updated to specpress 3.2.6

## [0.7.3] - 2026-07-01

### Added

- **DOCX DIFF e2e test** - Automated end-to-end test for multi-version DOCX comparison; gracefully skipped on non-Windows or when Microsoft Word is not installed

### Changed

- **DOCX DIFF** - Enhanced multi-version tracked-changes comparison:
  - Compare 2-5 versions (commits or local files) in a single operation (previously limited to 2)
  - Author attribution per version transition with smart defaults from commit hash + message
  - CR-based filename generation when `spec/history/CRxxxx.json` exists
  - Headless Word automation runs invisibly in the background
  - See [detailed DOCX DIFF documentation](documentation/DOCX-DIFF.md)
- **Refactoring** - Extracted `findWinword` into `src/utils/winword.js` (no VS Code dependency) so it can be shared between extension code and tests
- Updated to specpress 3.2.4

### Security

- Updated dependencies to fix 3 vulnerabilities: `linkify-it` (high), `markdown-it` (moderate), `qs` (moderate)

## [0.7.2] - 2026-06-01

### Added

- **Multi-File Preview Cover Page Selection** - When previewing spec root, users can now choose between CR cover page, standard front page, or no cover page (same options as DOCX export)
- **.vscode/settings.json** - Settings for indentation and JSON formatting.

### Changed

- Update to specpress 3.2.3

### Fixed

- Bundle missing icons with VSIX package.

### Removed

- **Reconfirm Comment Position** command - Removed redundant command (replaced by automatic validation on save and "Validate Comment Positions" with multi-select)

## [0.7.1] - 2026-05-28

### Added

- **Commenting System** - Collaborative document review with threaded comments
  - Add comments at specific line/column positions in markdown and ASN.1 files
  - Nested replies with unlimited depth
  - Resolve/unresolve workflow with status indicators (red/yellow/green)
  - Position tracking with ±20 character context snippets
  - Automatic detection when comments move due to text edits
  - Position validation and automatic updates when saving MD/ASN.1 files
  - Reconfirm position button to manually update comment locations
  - Rich filtering by text, author, and resolution status
  - Tree view showing comments grouped by file
  - Detail view with inline markdown editor
  - Editor decorations (gutter markers, hover tooltips)
  - Multi-author collision warnings
  - 5-minute in-memory cache for performance
  - Git-friendly JSON file storage
- **Improved Live Preview** - Loads preceding and subsequent files/sections when scrolling and thereby reduces the need to toggle between single- and multi-page preview.
- **CR Cover Page** support
  - JSON schema for CR cover pages provides interactive help, auto completion and syntax checking when filling the meta data for the CR cover page.
  - Interactive selection dialog for DOCX export
  - Automatic detection of CR JSON files in `history/` folder
  - Comprehensive validation with detailed error messages
  - Quick pick dialog with available options:
    - CR Cover Page (with filename)
    - Standard Front Page (if configured)
    - No Front Page
  - Invalid CR files shown as disabled with error description
  - "Open CR File" button for quick access to fix validation errors
  - Works in both export and preview modes
  - No configuration needed - fully interactive
- **Debug Logging** - Optional debug logging to temp file for troubleshooting
  - Enable via `specpress.enableDebugLogging` setting
  - View log with "SpecPress: Show Debug Log" command
  - Useful when running in Extension Development Host

### Changed

- **Configuration** - Renamed `specpress.coverPageData` to `specpress.frontPageData` (old name deprecated but still works)
- **Multi-File Preview** - Improved performance with better caching
- **Preview Manager** - Fixed bug where specRoot was used before being defined in multi-file preview
- Updated to specpress 3.2.2

### Fixed

- **Preview Rendering** - Fixed crashes due to undefined variables in CR cover page detection
- **HTML Escaping** - Fixed escapeHtml function to handle non-string values
- **Comment Position Validation** - Fixed fuzzy matching for whitespace changes

## [0.6.13] - 2024-01-15

### Added

- Initial public release
- Live preview of markdown and ASN.1 files
- Multi-file preview with folder selection
- HTML export with media directory
- DOCX export with 3GPP styling
- DOCX DIFF for tracked-changes comparison
- Cover page support with template and data files
- Section numbering from folder/file hierarchy
- Mermaid diagram rendering
- LaTeX equation rendering
- ASN.1 syntax highlighting
- Synchronized scrolling in preview
- JsonTable support
- JsonTable Editor - WYSIWYG table editor for JsonTable files
- Change Tracking Preview - Show tracked changes in live preview

### Changed

- Updated to specpress 3.1.0

### Fixed

- Various stability improvements

## [0.6.0] - 2023-12-01

### Added

- Initial beta release
- Basic preview functionality
- DOCX export support

[0.7.6]: https://github.com/Ericsson/SpecPressExt/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/Ericsson/SpecPressExt/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/Ericsson/SpecPressExt/compare/v0.7.3...v0.7.4
[0.7.4]: https://github.com/Ericsson/SpecPressExt/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/Ericsson/SpecPressExt/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/Ericsson/SpecPressExt/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/Ericsson/SpecPressExt/compare/v0.6.13...v0.7.1
[0.6.13]: https://github.com/Ericsson/SpecPressExt/releases/tag/v0.6.13
[0.6.0]: https://github.com/Ericsson/SpecPressExt/releases/tag/v0.6.0
