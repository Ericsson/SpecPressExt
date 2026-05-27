# Changelog

All notable changes to the SpecPress Extension for VS Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Commenting System** - Collaborative document review with threaded comments
  - Add comments at specific line/column positions in markdown and ASN.1 files
  - Nested replies with unlimited depth
  - Resolve/unresolve workflow with status indicators (red/yellow/green)
  - Position tracking with ±20 character context snippets
  - Automatic detection when comments move due to text edits
  - Position validation and batch update command
  - Reconfirm position button to manually update comment locations
  - Rich filtering by text, author, and resolution status
  - Tree view showing comments grouped by file
  - Detail view with inline markdown editor
  - Editor decorations (gutter markers, hover tooltips, CodeLens indicators)
  - Multi-author collision warnings
  - 5-minute in-memory cache for performance
  - Git-friendly JSON file storage
- **CR Cover Page Selection** - Interactive selection dialog for DOCX export
  - Automatic detection of CR JSON files in `assets/` folder
  - Comprehensive validation with detailed error messages
  - Quick pick dialog with available options:
    - CR Cover Page (with filename)
    - Standard Front Page (if configured)
    - No Front Page
  - Invalid CR files shown as disabled with error description
  - "Open CR File" button for quick access to fix validation errors
  - Works in both export and preview modes
  - No configuration needed - fully interactive
- **JsonTable Editor** - WYSIWYG table editor for JsonTable files
  - Double-click cells to edit markdown content
  - Drag to reorder rows/columns
  - Merge cells via context menu
  - Real-time rendered output preview
  - Markdown toolbar (Bold, Italic, Code, Line break)
- **Change Tracking Preview** - Show tracked changes in live preview
  - Compare current version against any git baseline commit
  - Insertions shown in blue with underline
  - Deletions shown in red with strikethrough
  - Changed images/diagrams shown side by side
  - Real-time updates as you edit
- **Debug Logging** - Optional debug logging to temp file for troubleshooting
  - Enable via `specpress.enableDebugLogging` setting
  - View log with "SpecPress: Show Debug Log" command
  - Useful when running in Extension Development Host

### Changed

- **Configuration** - Renamed `specpress.coverPageData` to `specpress.frontPageData` (old name deprecated but still works)
- **Multi-File Preview** - Improved performance with better caching
- **Preview Manager** - Fixed bug where specRoot was used before being defined in multi-file preview

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
- JsonTable support
- LaTeX equation rendering
- ASN.1 syntax highlighting
- Synchronized scrolling in preview

### Changed

- Updated to specpress 3.1.0

### Fixed

- Various stability improvements

## [0.6.0] - 2023-12-01

### Added

- Initial beta release
- Basic preview functionality
- DOCX export support

[Unreleased]: https://github.com/Ericsson/SpecPressExt/compare/v0.6.13...HEAD
[0.6.13]: https://github.com/Ericsson/SpecPressExt/releases/tag/v0.6.13
[0.6.0]: https://github.com/Ericsson/SpecPressExt/releases/tag/v0.6.0
