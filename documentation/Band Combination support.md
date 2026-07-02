# Implementation plan

## Feature requirements

The Band Combination pane should support:

- Configuration parameter "bandCombinationFolder" to set the top level directory in which to search for band combinations and bands. If the parameter "bandCombinationFolder" is not set, the pane could still be visible  but should show a hint that the parameter must be configured first (preferably with a link to open the settings.json file)
- Tree View — BC files sorted by BC_ID order, with filtering by band number, number of carriers, FR1/FR2, etc.
  - Filter by ...
    - DL bcId
    - file name
    - BcsId,
    - contained band numbers
    - Selectors for "Bands",  "CA Configurations", "DC Configuration"
  - Clicking on an entry in the view should open the JSON file in the editor
  - Each entry in the tree view should have a tick-box. The files selected therein should be shown in the HTML live preview. If none is selected, the preview should follow the last clicked/opened entry from the list.
  - Show some progress indicator in the side pane telling the user that the BCs are being loaded (it takes quite some time)
- Buttons in the new Band Combination pane start the validation of all band combinations.
  - Options to skip regular validation and/or schema validation.
  - Button to start validation and an icon showing whether it succeeded or not.
  - Should write output to a temporary "*.log" file and offer button to open it in an editor window.
- WebView — live HTML table preview of the currently open BC JSON file (using the existing toHTML / HtmlTable logic). It should be in the main pane and show up by default in a split editor view like the specpressext existing spec preview.
- A button to "Normalize" the currently opened file. (see specpress's "lib\ran4\NormalizeBC.ts")

## Architecture plan

- The new pane activates on the workspace containing the 38.101 data
- A TreeDataProvider loads the BC JSON files, parses each bcId field, and sorts/groups them using the BC_ID class
- A WebviewPanel renders the HTML when a BC file is opened/selected.

# Current implementation status

## Launch configuration (done)

Updated `.vscode/launch.json` to open the 38.101 specifications folder (`C:\Data\git\repo\3gpp\ran4\specifications\38.101`) when pressing F5 for testing.

Added `specpress.bandCombinationFolder` configuration parameter (set to `"."`) in the 38.101 workspace `settings.json` to enable the Band Combination pane.

## Basic Band Combination pane structure (done)

- Created `src/vscode/bandcombinations/` directory
- `bcTreeProvider.js` — scans for `CA_*.json` and `DC_*.json` files recursively, parses `bcId` field, displays in tree
  - Shows "Configuration Required" hint with link to settings when `bandCombinationFolder` is not set
  - Shows "No Band Combinations Found" when folder is configured but empty
  - Automatically refreshes when `bandCombinationFolder` setting changes
  - **BC_ID-based sorting** using the validator's `BC_ID.lessThan()`/`greaterThan()` methods with fallback to string sort
  - **Type filters**: controls which file types are loaded (CA, DC, Bands)
    - DC files not loaded by default for performance
    - Only enabled types are scanned from disk
    - Supports single-band files (n*.json) in addition to CA/DC
  - **Search/display filters**: 
    - **BC ID**: Exact match (case-insensitive) for specific BC configurations
    - **Band Numbers**: Multi-select with autocomplete dropdown
      - Type to search, Enter to add band to selection
      - Shows fuzzy-matched bands as you type (max 10 suggestions)
      - Click chip × to remove band from selection
      - "Only" mode: shows BCs containing exactly the selected bands (auto-applies on mode change)
      - "At Least" mode (default): shows BCs containing selected bands plus possibly more (auto-applies on mode change)
    - **Number of Carriers**: Uses BC_ID.getNrofCarriers() for accurate counting
      - "Exactly" mode (default): exact match (auto-applies on mode change)
      - "At Least" mode: shows BCs with this many or more carriers (auto-applies on mode change)
      - "Up To" mode: shows BCs with this many or fewer carriers (auto-applies on mode change)
    - **Properties**: Toggle buttons for BC_ID boolean properties (all filters are AND-ed)
      - **Intra**: filters for intra-band combinations (BC_ID.isIntraBand())
      - **FR1**: filters for frequency range 1 (BC_ID.isFr1())
      - **FR2**: filters for frequency range 2 (BC_ID.isFr2())
      - **NR**: filters for NR-only combinations (BC_ID.isNR())
      - **SUL**: filters for supplementary uplink (BC_ID.isSUL())
      - Buttons auto-apply filter when toggled
      - Multiple properties can be active simultaneously (e.g., "FR1 + NR" shows only FR1 NR-only combinations)
    - **Git Status**: Toggle button for modified files
      - **Modified only**: shows only files with git status M (modified), A (added), or ? (untracked)
      - Uses `git status --porcelain` to detect changes
      - Scans for multiple git repos in BC folder structure (e.g., ts-38.101-1, ts-38.101-2, ts-38.101-3)
      - Results cached until manual refresh for performance
      - Auto-applies filter when toggled
      - Useful for reviewing all edited files in a session regardless of other filter settings
  - **Tree view count**: Shows number of matching configurations in tree description, e.g., "Band Combinations (42)"
  - **Processing indicator**: Filter button changes to orange "Processing..." during filtering operations for better visibility
  - Filter state stored in tree provider, applied before sorting and display
- `bcFilterViewProvider.js` — fully functional filter UI webview
  - **Type toggle buttons** at the top: CA (enabled), DC (disabled), Bands (enabled)
    - Toggle buttons control what file types are loaded from disk
    - DC disabled by default for performance (thousands of DC files)
    - Changes trigger immediate reload with only selected types
    - Visual active/inactive states with color coding
  - Three filter inputs: BC ID (substring match), Band Number (e.g., "n78"), Number of Carriers (exact match)
  - Filter and Clear buttons
  - Filters apply on button click or Enter key
  - Communicates with tree provider to update display
- `bcValidationViewProvider.js` — validation UI webview between filter and tree views
  - **Validation controls**:
    - Scope selector: Bands only / Bands+CA / Bands+CA+DC
    - Validation type checkboxes: Content validation, Schema validation
    - Run Validation button (▶ icon)
  - **Recent logs list**: Shows up to 5 most recent validation log files by date/time
    - Clickable entries open log file in editor
    - Refresh button (⟳) to update log list
    - Auto-updates after each validation run
  - All validation logic moved from bcCommands.js to the view provider
  - Writes output to timestamped log files in OS temp directory
  - Shows success/error notifications after validation
- `bcCommands.js` — command handlers for refresh, open preview, normalize, configure folder, preview filtered, export git diff, and toggle preview
  - `bcValidate` and `bcOpenLog` functions removed (functionality moved to bcValidationViewProvider)
  - `bcNormalize` — normalizes currently open CA/DC JSON file using the validator
  - `bcPreviewFiltered` — generates multi-BC HTML preview for all currently filtered entries
    - Limited to first 100 entries for performance
    - Shows info message if more than 100 entries match
    - Accessible via eye icon ($(eye)) toolbar button
  - `bcExportGitDiff` — exports git diff files between commits or commit and local files
    - Scans for git repos in BC folder (supports multiple repos like ts-38.101-1, ts-38.101-2, ts-38.101-3)
    - Shows repo picker if multiple repos found
    - Two-step commit picker: FROM version, then TO version (with "Local files" option)
    - Generates standard unified diff format (.diff or .patch)
    - Default filename includes timestamp, repo name, and commit hashes (e.g., `2024-01-15 14-30-00 ts-38.101-1_abc1234_to_def5678.diff`)
    - Saves to configured `defaultExportFolder`
    - Accessible via diff icon ($(diff)) toolbar button
  - `configureBcFolder` opens workspace settings.json or settings UI
- `bcPreviewManager.js` — manages webview panel preview (split editor) for BC JSON files with live updates
  - Opens JSON file in left pane (ViewColumn.One) and HTML preview in right pane (ViewColumn.Two) for side-by-side editing
  - **Single-BC mode**: Shows individual BC with live editing support (debounced 500ms)
  - **Multi-BC mode**: Shows concatenated table of up to 100 filtered BCs
    - Entries sorted using BC_ID comparison (same as tree view)
    - Live editing disabled in multi-BC mode
    - Simplified HTML output without file/BCS info headers
  - Uses the validator's `BC.toHTML()` method for proper HTML rendering
  - Uses the validator's `BandCombinationList.addTableHeaders()` for column headers (single source of truth)
  - Sticky table headers for better scrolling in multi-BC preview
  - Renders `&nbsp;` values as empty cells (not as escaped text)
  - Falls back to simple JSON view if validator import fails
  - Renders HtmlTable output with proper table structure and rowspan handling
- Updated `extension.js` to always initialize BC pane (not conditionally)
- Updated `package.json` to:
  - Use `onStartupFinished` activation event (ensures BC pane is always available)
  - Add `configureBcFolder` command
  - Add `bcPreviewFiltered` command with eye icon ($(eye))
  - Add `bcExportGitDiff` command with diff icon ($(diff))
  - Add explorer context menu item for CA_*.json and DC_*.json files
  - Add `bcNormalize` command accessible from toolbar and explorer context menu
- Pane is always visible in activity bar
- Tree view shows:
  - Configuration hint when not configured (click to open settings)
  - Empty state when no BC files found
  - BC files with their bcId when properly configured
  - Count of matching entries in tree description (e.g., "Band Combinations (42)")
- Clicking BC entry opens preview panel in split editor
- Right-click CA_*.json or DC_*.json files in explorer → "Open Band Combination Preview" or "Normalize Band Combination"
- Preview panel shows full Band Combination table rendered via the validator
- Live preview updates when editing JSON files (500ms debounce) in single-BC mode
- Multi-BC preview shows up to 100 filtered entries in a single table (eye icon toolbar button)
- Export git diff between any two commits or commit and local files (diff icon toolbar button)
- **Footnotes for notes**: UL and DL notes appear as superscript text with tooltips
  - UL notes (e.g., `{"pc2": true}`) appear after band numbers: `n25<sup title="...">pc2</sup>`
  - DL notes (BC-level) appear after BC-ID: `CA_n77A-n77A<sup title="...">intraReq</sup>`
  - Multiple notes separated by comma and space: `<sup>pc2</sup>, <sup>pc1p5</sup>`
  - Tooltip shows full description from JSON schema on hover
- **Clickable reference links**: Referenced components (refComponents) are rendered as clickable links
  - Band references (e.g., `n3`) link to band file (`n3.json`)
  - BC references (e.g., `CA_n3B_BCS0`) link to BC file (`CA_n3B.json`)
  - Clicking opens both JSON editor and HTML preview
  - Links styled with VS Code theme colors
  - Tree view regains focus after opening for easy keyboard navigation

**Testing note:** There was a JSON syntax error in `package.json` (unescaped backslash in regex) that prevented the extension from loading. This has been fixed. Now press F5 to see the BC pane.

## package.json contributions (done)

The following has been added to `package.json`:

- **Activity bar container** `specpress-bandcombinations` with `$(list-tree)` icon.
- **Three views:**
  - `specpressBcFilter` — webview for filter/selector UI
  - `specpressBcValidation` — webview for validation controls and recent logs
  - `specpressBcTree` — tree view for sorted BC list
- **Five toolbar commands** on `specpressBcTree`:
  - `specpress.bcRefresh` (refresh icon) — reload BC files
  - `specpress.bcNormalize` (symbol-namespace icon) — normalize current BC file
  - `specpress.bcPreviewFiltered` (eye icon) — preview filtered BCs in HTML table
  - `specpress.bcExportGitDiff` (diff icon) — export git diff between versions
  - `specpress.bcTogglePreview` (eye icon / eye-closed icon) — toggle auto preview on tree selection
- **Configuration:** `specpress.bandCombinationFolder` (string) — path to the 38.101 data repository root.

## RAN4 validator integration (done)

The RAN4 validator code (formerly "jsvalidator") has been merged into the specpress library under `lib/ran4/`. Since SpecPressExt is CommonJS and the validator is ESM, use **dynamic `import()`** in extension code:
  ```javascript
  const { BC_ID } = await import('specpress/lib/ran4/BC_ID.js')
  const { BC, BandCombinationList } = await import('specpress/lib/ran4/BandCombinations.js')
  const { loadAndValidateAll } = await import('specpress/lib/ran4/ValidateData.js')
  ```

## RAN4 validator changes made during development

### BandCombinations.ts — static addTableHeaders method (new)

Added `BandCombinationList.addTableHeaders(aHtmlTable: HtmlTable)` as a static helper method that:
- Sets the standard 6 column headers for BC tables
- Can be called by any code rendering BC tables (CLI export, VS Code preview, etc.)
- Ensures consistency across all BC table renderings
- Refactored existing `storeAsHtmlFile()` to use this method

This provides a single source of truth for the table structure. Future enhancements (hyperlinks, hover text, etc.) only need to be implemented once in the validator.

### BWC_ID.ts — getNrofCarriers() method (new)

Added `BWC_ID.getNrofCarriers(aFrequencyRange: number = 0)` method that:
- Returns the actual number of physical carriers from BWCValue tables
- Takes frequency range parameter (0=auto, 1=FR1, 2=FR2)
- Used by BC_ID.getNrofCarriers() for accurate carrier counting

### BC_ID.ts — getNrofCarriers() method (updated)

Added `BC_ID.getNrofCarriers()` method that:
- Returns the total number of component carriers across all bands
- Sums the non-contiguous carrier count from each band's BWC-ID using `BWC_ID.getNrofNonContiguousCarriers()`
- Handles DC configurations with EUTRA bands (uses heuristic for raw DC strings)
- Examples:
  - `"CA_n1A-n3A"` returns 2 (1+1 carriers)
  - `"CA_n3B"` returns 2 (contiguous pair)
  - `"CA_n1A-n3(2A)"` returns 3 (1+2 carriers)

Used by SpecPressExt carrier count filter for accurate filtering.

### NormalizeBC.ts (new script)

A helper at `specpress/lib/ran4/NormalizeBC.ts` that loads a single BC JSON file and saves it back normalized:
```bash
npx tsx src/NormalizeBC.ts <path-to-BC-json-file>
```
Normalization effects:
- Key ordering enforced by `toJSON()` methods (e.g. `bcsId` → `ulConfigList` → `bandList`)
- UL configs sorted: band numbers first (numerically), then BC-IDs (using BC_ID sort order)
- `notes` object keys sorted alphabetically
- Consistent indentation via `RAN4JsonEncoder`

A VS Code task is configured in `specpress/.vscode/tasks.json` bound to a keyboard shortcut. Uses `node --import tsx/esm` for clean process exit. Terminal auto-closes silently.

### JsonTools.ts — alphabetical key sorting

`RAN4JsonEncoder.writeValue()` now sorts object keys with `Object.keys(...).sort()` when serializing plain objects (affects `notes` fields).

### BandCombinations.ts — Footnotes and clickable links (new)

Added HTML rendering enhancements for notes and references:
- `UlConfig.toStringWithNotes(ulNoteDescriptions?)` — generates HTML with superscript footnotes for notes
  - Accepts optional description map loaded from schema at runtime
  - Each note rendered as `<sup title="description">noteKey</sup>`
  - Multiple notes separated by ", "
  - Falls back to note key if description not provided
- `BCS.toHTML()` — updated to accept and pass `ulNoteDescriptions` parameter
- `BC.toHTML(aHtmlTable, aRow, aColumn, ulNoteDescriptions?, dlNoteDescriptions?)` — adds superscript footnotes to DL Configuration column
  - Accepts optional description maps for both UL and DL notes
  - Same format as UL notes with comma-space separation
  - Descriptions loaded from schema by caller (SpecPressExt)
- `RefComponent.toHTMLLink()` — generates clickable HTML links for referenced components
  - Band references: `<a href="#" class="bc-ref-link" data-ref="n3">n3</a>`
  - BC references: `<a href="#" class="bc-ref-link" data-ref="CA_n3B" data-bcs="0">CA_n3B_BCS0</a>`
  - Used by `BandEntry.toHTML()` for displaying refComponents as links

**Architecture**: Note descriptions are NOT hardcoded in the validator. They are loaded from JSON schema files at runtime by SpecPressExt and passed as parameters. This ensures descriptions stay synchronized with the schema as it evolves.

`BCS.toJSON()` sorts `ulConfigList` before writing: band numbers first (by numeric value), then BC-IDs (using `BC_ID.lessThan()`).

### BandCombinations.ts — error context for InvalidBwcIdException

- `BC` constructor wraps `new BC_ID(...)` in try/catch, re-throws with `BC('<bcId-string>'): <original message>`.
- `BandEntry.validate()` wraps `new BC_ID(...)` in try/catch, re-throws with `this.getDescriptor(): <original message>`.

### DualConnectivity.ts — error context for InvalidBwcIdException

`DualConnectivityConfig` constructor wraps `new BC_ID(...)` in try/catch, re-throws with `DualConnectivityConfig('<bcId-string>'): <original message>`.

### Utils.ts — graceful error handling in _loadFiles

`BaseList._loadFiles()` now catches exceptions from `_createEntry()`. In `--no-abort` mode, it logs the error with file path context and continues loading remaining files instead of crashing.

## Merge of RAN4 validator into specpress (done)

The RAN4 validator (formerly the standalone "jsvalidator" repository) has been merged into specpress under `lib/ran4/`.

**Structure:**
```
specpress/
  lib/
    common/           ← existing specpress common code (JS)
    md2html/          ← existing markdown-to-HTML (JS)
    md2docx/          ← existing markdown-to-DOCX (JS)
    ran4/             ← RAN4 validator code (TS)
      BC_ID.ts
      BWC_ID.ts
      BandCombinations.ts
      DualConnectivity.ts
      ChannelBandwidthPerBand.ts
      RAN4DataHandler.ts
      ValidateData.ts
      ...
    cli/
      export-html.js
      export-docx.js
      validate-ran4.js  ← CLI wrapper for RAN4 validation
      normalize-ran4.js ← CLI wrapper for BC normalization
  test/lib/
    ran4/             ← RAN4 validator tests (322 tests)
  dist/lib/ran4/      ← compiled output (built via tsc)
  package.json        ← exports: {"./lib/ran4/*": "./dist/lib/ran4/*"}
  tsconfig.json       ← compiles lib/ran4/**/*.ts to dist/lib/ran4/
```

**Usage:**
- CI pipelines: `npx specpress-validate-ran4 <rootFolder>`
- SpecPressExt: `await import('specpress/lib/ran4/BC_ID.js')`
- Other projects: `npm install specpress` then import RAN4 classes

**Future evolution path (optional):**
- **Phase 2:** Enable `"allowJs": true` in tsconfig to allow TS/JS coexistence
- **Phase 3:** Gradually convert existing JS files to TS (non-breaking, at own pace)
