/**
 * Consolidated state manager for the SpecPress extension.
 *
 * Replaces the scattered module-level variables with a single state object
 * that can be passed between command handlers.
 */
class StateManager {
  constructor() {
    /** @type {import('vscode').WebviewPanel|null} Singleton webview panel for preview */
    this.panel = null
    /** @type {Object|null} Lazily initialized Md2Html handler */
    this.handler = null
    /** @type {import('vscode').TextEditor|null} Currently previewed editor */
    this.currentEditor = null
    /** @type {import('vscode').Disposable|null} Listener for document text changes */
    this.updatePreview = null
    /** @type {import('vscode').Disposable|null} Listener for editor scroll position changes */
    this.scrollSync = null
    /** @type {import('vscode').Disposable|null} Listener for file saves (JSON changes) */
    this.fileSaveListener = null
    /** @type {boolean} Whether the current preview shows multiple files */
    this.isMultiFilePreview = false
    /** @type {boolean} Guard flag to prevent scroll feedback loops from editor */
    this.isEditorScrolling = false
    /** @type {boolean} Guard flag to prevent scroll feedback loops from preview */
    this.isPreviewScrolling = false
    /** @type {string|null} Concatenated markdown content for multi-file export */
    this.multiFileContent = null
    /** @type {string|null} Base directory of the first file in multi-file preview */
    this.multiFileBaseDir = null
    /** @type {string[]|null} Markdown file paths used in multi-file preview for image resolution */
    this.multiFilePaths = null
    /** @type {string[]|null} All source file paths (md + asn) used in multi-file preview */
    this.multiFileAllFiles = null
    /** @type {boolean} Tracks whether the editor or preview was last focused */
    this.lastFocusedIsEditor = true
    /** @type {import('vscode').Uri[]|null} URIs from the most recent multi-file preview */
    this.lastMultiFileUris = null
    /** @type {boolean} Whether the current multi-file preview covers a spec root */
    this.isSpecRootPreview = false
    /** @type {{file: string, line: number}|null} Last single-file position for scroll restore */
    this.restoreScrollTarget = null
    /** @type {{file: string|null, line: number}|null} Last right-clicked element's source info */
    this.lastContextTarget = null
    /** @type {string|null} Last folder chosen for export, remembered across exports within a session */
    this.lastExportFolder = null
    /** @type {boolean} Whether auto-preview is active */
    this.autoPreviewActive = false
    /** @type {string|null} Baseline commit for change tracking (null = disabled) */
    this.changeTrackingCommit = null
    /** @type {string|null} Repo root for change tracking */
    this.changeTrackingRepoRoot = null
    /** @type {Map<string,string|Buffer>|null} Cached baseline file contents */
    this.changeTrackingBaseline = null
  }

  /** Disposes listeners and resets preview-related state. */
  disposeListeners() {
    if (this.updatePreview) this.updatePreview.dispose()
    if (this.scrollSync) this.scrollSync.dispose()
    if (this.fileSaveListener) this.fileSaveListener.dispose()
    this.updatePreview = null
    this.scrollSync = null
    this.fileSaveListener = null
  }

  /** Resets all multi-file state. */
  resetMultiFileState() {
    this.multiFileContent = null
    this.multiFileBaseDir = null
    this.multiFilePaths = null
    this.multiFileAllFiles = null
  }

  /** Called when the panel is disposed. */
  onPanelDisposed() {
    this.panel = null
    this.autoPreviewActive = false
    this.disposeListeners()
    this.resetMultiFileState()
  }
}

module.exports = { StateManager }
