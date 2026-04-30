# 1 SpecPress Extension for VS-Code

The SpecPress Extension for VS-Code offers functionality to convert 3GPP specifications (written in a tree of markdown, asn, json... files) into an HTML or DOCX file that offers the same look&feel as 3GPP's traditional DOCX specifications.

The extension integrates into VS-Code/VS-Codium where it renders a live preview of the opened/selected documents or folders and offers menu options to export the files in HTML or DOCX format.

The extension is a thin VS Code integration layer on top of the [specpress](https://github.com/Ericsson/specpress) library, which contains the core conversion logic (markdown-to-HTML, markdown-to-DOCX, section numbering, ASN.1 handling, etc.).

## 1.1 Feature Overview

- **Live preview** - Live preview of the currently edited Markdown- or ASN.1 file with real time updates and synchronized scrolling.
- **Multiple File Preview** - Shows a concatenated live preview of all selected files and/or folders in the VSC explorer pane.
- **HTML Export** - Export current preview or the selected files/folders to a standalone HTML file with a media directory containing all images. Supports exporting from local files or from any git commit/branch/tag.
- **DOCX Export** - Exports the selected files/folders as a DOCX document in 3GPP style including appropriate style settings. Supports exporting from local files or from any git commit/branch/tag.
- **DOCX DIFF** - Exports two DOCX documents from two different versions (local version, branches, commits, ...) and generates a tracked-changes comparison in MS-Word.
- **Change Tracking Preview** - Shows tracked changes (insertions/deletions) directly in the live preview by comparing the current version against any git baseline commit.
- **Cover Page** - Configurable cover page for spec-root-level exports in both HTML and DOCX.
- **JsonTable Editor** - A WYSIWYG table editor for JsonTable files (JSON-defined tables used by specpress). Double-click cells to edit markdown content, drag to reorder rows/columns, merge cells via context menu, and see rendered output in real time.

## 1.2 Installation

Ensure that VS-Code or VS-Codium is installed. Download the latest `.vsix` file from the [GitHub Releases](https://github.com/Ericsson/SpecPressExt/releases) page.

Install the VSIX file:

Follow the instructions at [Install from a VSIX](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix). Alternatively, use the command line as follows:

- **VS-Code**: Run:

  ```bash
  code --install-extension specpressext-x.y.z.vsix
  ```

- **VS-Codium**: Run:

  ```bash
  codium --install-extension specpressext-x.y.z.vsix
  ```

### 1.2.1 Building from Source

If you prefer to build the VSIX locally instead of downloading from [GitHub Releases](https://github.com/Ericsson/SpecPressExt/releases):

```bash
git clone https://github.com/Ericsson/SpecPressExt.git
cd SpecPressExt
npm install
build.cmd
```

Requires Node.js 16 or higher. Before building a new release, remember to increment the version number in [package.json](package.json).

The build script performs the following steps:

1. Performs a clean `npm install` (removes node_modules and package-lock.json).
2. Runs the full test suite (`npm test`) — aborts if any test fails.
3. Packages the extension into a `.vsix` file in the repository root.

Install the resulting file as described in [1.2 Installation](#12-installation).

For standalone (CLI) usage and CI pipeline integration, see the [specpress](https://github.com/Ericsson/specpress) library.

## 1.3 Getting started

To try SpecPress with an example specification:

1. **Install Git** if not already available: download from [https://git-scm.com/](https://git-scm.com/) and follow the installation instructions for your platform.

2. **Clone the example specification** to a local directory:

   ```bash
   git clone https://forge.3gpp.org/rep/fs_6gspecs_new/ericsson_multifiletypes_onem2m_example
   ```

3. **Open the cloned folder in VS Code** (File → Open Folder, or `code ericsson_multifiletypes_onem2m_example`).

4. **Preview a single file**: Open any `.md` file in the editor, right-click and choose `SpecPress: Open Preview`. A live preview appears in a side panel.

5. **Switch to the multi-page preview**: In the Explorer pane, select the specification root folder, right-click and choose `SpecPress: Preview Selected`. Press Enter to preview the local version.

This example repository already includes the necessary SpecPress configuration (in `.vscode/settings.json`). For details on configuration options see [1.4 Configuration](#14-configuration). For the full set of features see [1.5 Usage](#15-usage).

## 1.4 Configuration

The VSC extension requires a few configuration parameters. It is recommended to configure those in the `settings.json` inside the workspace in which you develop your specification. This ensures that all users use the same settings and that individual users don't need to configure the settings themselves.

The following settings can be configured in VS-Code's workspace or user settings under the `specpress` prefix:

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `specpress.specificationRootPath` | string or string[] | `""` | (*mandatory*) Path(s) to the specification root folder(s), relative to workspace root or absolute. Set it to `"."` if your specification root is equal to your workspace root. |
| `specpress.deriveSectionNumbers` | boolean | `false` | Enable automatic section number derivation from folder/file hierarchy. |
| `specpress.coverPageTemplate` | string | `""` | Path to an HTML template for the cover page. |
| `specpress.coverPageData` | string | `""` | Path to a JSON file with cover page placeholder values. |
| `specpress.defaultExportFolder` | string | `""` | Default folder for HTML and DOCX export dialogs. Overridden by the last chosen folder during the session. |
| `specpress.multiPagePreviewDefaultPath` | string | `""` | Default path for the "Restore Multi-File Preview" command. |
| `specpress.renderers` | object | `{}` | Custom HTML renderers for markdown elements (advanced). |
| `specpress.cssFile` | string | SpecPress default | Path to a custom CSS file for HTML preview and export. It is recommended not to set this parameter and rather rely on the default CSS provided with the SpecPressExtension. |
| `specpress.mermaidConfigFile` | string | SpecPress default | Path to a mermaid configuration JSON file. It is recommended not to set this parameter and rather rely on the default configuration provided with the SpecPressExtension. |

## 1.5 Usage

### 1.5.1 Automatic live preview

After installing and configuring the extension, open a markdown- or ASN.1 file within your `specificationRootPath` in the VSC editor. Right-click into the editor to open the context menu and choose `SpecPress: Open Preview`. The SpecPress extension opens a live preview, updates it as you edit your source file and scrolls accordingly.

![Live preview of markdown files](images/01_using_live_preview.png)

Figure 1.5.1-1: Live preview of markdown files

When you switch to another source file the live preview updates, too.

When you close the preview it remains closed until you re-open it via the context menu.

### 1.5.2 Multiple-Files

We expect the specification to be split into many markdown-, ASN.1- and JSON files which represent one or a few sub-section each. Furthermore, those markdown files should be ordered in a suitable folder structure (e.g. by sections).

To preview a rendered version of some or all source files, select the files and/or folders in the explorer pane (using Ctrl- or Shift) and right-click to open the context menu. Choose "SpecPress: Preview Selected".

SpecPress asks for the version that you would like to preview. Press *ENTER* to see the current version of the local files. Alternatively, choose a Git commit from the drop-down menu or by pasting a hash.

![Context menu multi-file operation](images/02_context_menue_multi-file.png)

Figure 1.5.2-1: Context menu multi-file operation

Assume that you scroll in the multi-page preview and would like to edit a specific section. To open the corresponding source file in the editor pane, right click into the respective section of the preview and choose "SpecPress: Edit this section" (or try to double-click into the section). If you later want to switch to the previous multi-page preview, press "Ctrl-Shift-M".

### 1.5.3 ASN.1 files

Beyond regular markdown files SpecPress also comprehends *asn* files. If a live preview is activated for such files, the plug-in loads the content of those files and interprets it as content of a fenced code block of type *asn* (see below) and hence renders them in the same way. And when generating a preview of an entire folder (and possible sub-folders) the preview loads also the contained *asn* files and embeds them into the preview.

In the multi-page preview, SpecPress extracts leading comment lines (if any) and the module name from the *asn* file and creates a delimiting section heading for this ASN.1 module as well as a descriptive paragraph prior to the actual ASN.1 code.

![Live preview of ASN.1 files](images/03_live_preview_of_asn1.png)

Figure 1.5.3-1: Live preview of ASN.1 files

### 1.5.4 HTML export

The live-preview (of one or several files) may be exported to a standalone HTML file. Right-click onto the live preview and choose "**Export to HTML**". A save dialog opens with a timestamped default filename (e.g. `2026-03-31 14-30-00 Export.html`). The dialog initially opens in the folder configured via `specpress.defaultExportFolder`, or in the last used export folder.

The function converts and exports the concatenated files including an embedded CSS and scripts to render the embedded mermaid figures. It also creates a *media* directory next to the HTML file containing all images used in the document.

The HTML file can be shared and opened in a browser.

### 1.5.5 DOCX export

To export a DOCX version, select one or more files and/or folders in the VS-Code explorer pane. Right-click and choose "**Export Selected to DOCX**". The extension then guides you through the following steps:

1. **Version selection** — A searchable commit picker appears showing the 200 most recent git commits. Choose "Local files (current workspace)" to export the current working copy, or select a specific commit/branch/tag to export an older version. You can type to filter by commit message, hash, or ref name.

2. **Save location** — A save dialog opens with a timestamped default filename (e.g. `2026-03-31 14-30-00 Export.docx`). If exporting from a git commit, the short hash is appended (e.g. `...Export_abc1234.docx`). The dialog initially opens in the folder configured via `specpress.defaultExportFolder`, or in the last used export folder.

3. **Export** — The extension collects all markdown and ASN.1 files from the selection, processes section numbers, renders mermaid diagrams, converts equations, and generates the DOCX file with 3GPP-style formatting.

When exporting at the spec root level (i.e. the folder configured in `specpress.specificationRootPath`), a cover page is automatically included if `specpress.coverPageTemplate` and `specpress.coverPageData` are configured.

![DOCX file in MS-Word](images/06_docx_file_in_MS-Word.png)

Figure 1.5.5-1: A DOCX file exported by the SpecPress extension and opened in MS-Word

To generate a **PDF** version of the specification, it is recommended to generate the DOCX version and to convert that into PDF.

### 1.5.6 DOCX DIFF (Change Request)

The "**Compare as DOCX**" function generates a tracked-changes comparison between two versions of the specification. This is useful for creating traditional Change Requests (CRs) or for reviewing changes between any two versions.

1. **Select files/folders** — Choose the files or folders to compare in the explorer pane. Right-click and choose "**Compare as DOCX**".

2. **Baseline version** — Select the original (baseline) commit from the commit picker. This is the "before" version.

3. **Revised version** — Select the revised (target) commit, or choose "Local files" to compare against the current working copy.

4. **Author name** — Enter the author name for tracked changes (default: "SpecPress").

The extension generates two DOCX files (baseline and revised), then launches MS-Word with instructions to produce a legal black-line comparison. MS-Word must be installed for this function to work.

### 1.5.7 Change tracking preview

The live preview (single-file or multi-file) can show tracked changes against a baseline commit. This is useful for reviewing what has changed since a previous version without leaving the editor.

To enable change tracking, right-click into the preview and choose '**SpecPress: Enable Change Tracking**'. A commit picker appears — select the baseline commit to compare against. The preview then highlights:

- **Insertions** — shown in blue with underline
- **Deletions** — shown in red with strikethrough
- **Changed images/diagrams** — shown side by side (old and new)

The preview title changes to 'Preview (changes)' while change tracking is active. Edits to the source files are reflected in real time, with the diff updating as you type.

To disable change tracking, right-click the preview and choose '**SpecPress: Disable Change Tracking**'. The preview returns to its normal rendering.

### 1.5.8 3GPP style rendering

The specpress library performs extensive 3GPP-style rendering of markdown content (bullet styles, figure/table captions, NOTE/EXAMPLE/Editor's Note paragraphs, ASN.1 syntax highlighting, LaTeX equations, Annex headings, hyperlinks, JsonTable, etc.).

For full documentation of the rendering rules, see the [specpress README](https://github.com/Ericsson/specpress#3gpp-style-rendering).

![Example of a JsonTable in VS Code](images/05_example_of_JsonTable_in_vscode.png)

Figure 1.5.8-1: Screenshot of a JsonTable in VS-Code

### 1.5.9 Section numbering

Section numbering is a core feature of the specpress library. It derives section numbers automatically from the folder and file hierarchy using x-placeholders in headings and captions. Enable it by setting `specpress.deriveSectionNumbers` to `true`.

For full documentation of the section numbering rules (folder/file structure, x-placeholders, auto-generated headings), see the [specpress README](https://github.com/Ericsson/specpress#section-numbering).

### 1.5.10 Mermaid diagram caching

When exporting to DOCX, mermaid diagrams are rendered to SVG using a hidden VS-Code webview. The mermaid library (`mermaid.min.js`) is automatically downloaded from CDN on first use and cached in VS-Code's global storage. It is refreshed every 24 hours; if offline, the stale cache is reused.

The rendered SVGs are cached on disk (in a `cached/` directory next to the spec root) so that unchanged diagrams are never re-rendered. For full documentation of the SVG caching mechanism (cache location, cache keys, cleanup), see the [specpress README](https://github.com/Ericsson/specpress#mermaid-diagram-caching).

## 1.6 Development and Testing

### 1.6.1 Getting the source code

Clone the repository and install dependencies as described in [1.2.1 Building from Source](#121-building-from-source).

### 1.6.2 Running in debug mode

When you want to run the plugin in debug/development mode you should load this repo as workspace in VS-Code. Then you may press F5 to start the launch script (see ".vscode" subfolder). But before doing so, make sure that you cloned also an example specification e.g. from `https://forge.3gpp.org/rep/fs_6gspecs_new/ericsson_multifiletypes_onem2m_example`.

To work on both repos simultaneously (extension + specpress library), clone `specpress` as a sibling folder and run:

```bash
co-develop.cmd
```

This links your local specpress via `npm link`. Press F5 to launch the Extension Development Host with both local codebases active.

### 1.6.3 Running tests

All tests run with Node.js and do not require VS-Code. After `npm install`, run the test suite:

```bash
npm test
```

The extension-specific tests are in `test/vscode/` and cover the ConfigLoader, StateManager, and JsonTable editor logic.

The bulk of the conversion tests (markdown-to-HTML, markdown-to-DOCX, section numbering, ASN.1, etc.) live in the [specpress](https://github.com/Ericsson/specpress) library.

### 1.6.4 Architecture principles

This extension is a **thin VS Code shell** around the [specpress](https://github.com/Ericsson/specpress) library. The boundary is strict:

- Extension code (`src/vscode/`) handles ONLY VS Code integration: commands, webviews, configuration, UI.
- All markdown parsing, conversion, rendering, and file processing logic lives in `specpress`.
- Never duplicate specpress logic in the extension.

Key patterns:

- **ConfigLoader** — centralized settings access with caching; invalidated on `onDidChangeConfiguration`, re-reads lazily.
- **StateManager** — single object for all runtime state; no scattered module-level variables.
- **Command isolation** — each command handler is a self-contained async function in its own file under `src/vscode/`, receiving `state`, `config`, and `context` as parameters.
- **Singleton panel** — reuse the existing webview panel; clean up on disposal.
- **Lifecycle management** — tie listener disposal to panel disposal; push all disposables to `context.subscriptions`.

### 1.6.5 Coding style

- **CommonJS** modules (`require()` / `module.exports`)
- **2-space indentation**, no semicolons
- **Single quotes** for strings, template literals for HTML/multi-line
- **camelCase** for functions and variables, **PascalCase** for classes
- **Command IDs**: `specpress.` prefix (e.g., `specpress.preview`)
- Import dependencies at the top, grouped: VS Code API → Node.js built-ins → specpress library

### 1.6.6 Anti-patterns to avoid

- ❌ Implementing conversion logic in the extension — delegate to specpress
- ❌ Scattered module-level `let` variables — use StateManager
- ❌ Hardcoded path separators — use `path.join()`
- ❌ Ignoring user cancellation (null from dialogs/pickers) — always check and return early
- ❌ Creating new panels on every invocation — reuse with singleton pattern
