# Changelog

All notable changes to the SpecPress Extension for VS Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-05-28

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

[0.7.0]: https://github.com/Ericsson/SpecPressExt/compare/v0.6.13...v0.7.0
[0.6.13]: https://github.com/Ericsson/SpecPressExt/releases/tag/v0.6.13
[0.6.0]: https://github.com/Ericsson/SpecPressExt/releases/tag/v0.6.0
