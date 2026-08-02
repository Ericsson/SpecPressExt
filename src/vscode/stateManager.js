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
    /** @type {import('vscode').Disposable|null} Listener for editor selection (cursor) changes */
    this.selectionSync = null
    /** @type {import('vscode').Disposable|null} Listener for active-editor changes (file switching) */
    this.editorFocusListener = null
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
    /** @type {number} Start index of rendered context window */
    this.contextStartIdx = -1
    /** @type {number} End index of rendered context window */
    this.contextEndIdx = -1
    /** @type {boolean} Tracks whether the editor or preview was last focused */
    this.lastFocusedIsEditor = true
    /** @type {import('vscode').Uri[]|null} URIs from the most recent multi-file preview */
    this.lastMultiFileUris = null
    /** @type {object|null} CommitRef from the most recent multi-file preview */
    this.lastMultiFileCommitRef = null
    /** @type {object|string|null} Baseline ref from the most recent multi-file preview */
    this.lastMultiFileBaselineRef = null
    /** @type {boolean} Whether the current multi-file preview covers a spec root */
    this.isSpecRootPreview = false
    /** @type {{file: string, line: number}|null} Last single-file position for scroll restore */
    this.restoreScrollTarget = null
    /** @type {{file: string, line: number}|null} Target to position the single-file preview at
     *  once the webview reports it is ready (deterministic replacement for racy timers). */
    this.pendingScrollTarget = null
    /** @type {{file: string|null, line: number}|null} Last right-clicked element's source info */
    this.lastContextTarget = null
    /** @type {string|null} Last folder chosen for export, remembered across exports within a session */
    this.lastExportFolder = null
    /** @type {boolean} Whether auto-preview is active */
    this.autoPreviewActive = false
    /** @type {string|null} Baseline commit for change tracking (null = disabled) */
    this.changeTrackingCommit = null
    /** @type {string|null} Short hash of the change tracking baseline commit */
    this.changeTrackingShortHash = null
    /** @type {string|null} Repo root for change tracking */
    this.changeTrackingRepoRoot = null
    /** @type {import('../../specpress/lib/common/fileResolver').FileResolver|null} Resolver for baseline files */
    this.changeTrackingResolver = null
    /** @type {import('vscode').Range|null} Last visible range in editor for scroll direction detection */
    this.lastVisibleRange = null
    /** @type {string[]} Files in current preview context (current + neighbors) */
    this.contextFiles = []
    /** @type {number} Index of current editor file in contextFiles */
    this.currentFileIndex = -1
    /** @type {Map<string,string>} Cache of rendered HTML for adjacent files */
    this.adjacentFileCache = new Map()
    /** @type {boolean} Flag to suppress automatic scrollToFile after HTML reload */
    this.suppressScrollToFile = false
    /** @type {import('vscode').ViewColumn|null} Last known editor column of the preview
     *  panel. Tracked while the panel is visible because WebviewPanel.viewColumn becomes
     *  undefined once the panel is hidden (e.g. covered by a text editor in its group). */
    this.previewViewColumn = null
  }

  /** Disposes listeners and resets preview-related state. */
  disposeListeners() {
    if (this.updatePreview) this.updatePreview.dispose()
    if (this.scrollSync) this.scrollSync.dispose()
    if (this.selectionSync) this.selectionSync.dispose()
    if (this.editorFocusListener) this.editorFocusListener.dispose()
    if (this.fileSaveListener) this.fileSaveListener.dispose()
    if (this._crossFileSwitchTimer) {
      clearTimeout(this._crossFileSwitchTimer)
      this._crossFileSwitchTimer = null
      this._pendingCrossFileSwitch = null
    }
    this.updatePreview = null
    this.scrollSync = null
    this.selectionSync = null
    this.editorFocusListener = null
    this.fileSaveListener = null
  }

  /** Resets all multi-file state. */
  resetMultiFileState() {
    this.multiFileContent = null
    this.multiFileBaseDir = null
    this.multiFilePaths = null
    this.multiFileAllFiles = null
    this.contextFiles = []
    this.currentFileIndex = -1
    this.adjacentFileCache.clear()
  }

  /** Called when the panel is disposed. */
  onPanelDisposed() {
    // If we are intentionally replacing the panel, don't reset state —
    // the new panel is already being set up by the caller.
    if (this._replacingPanel) return
    this.panel = null
    this.autoPreviewActive = false
    this.disposeListeners()
    this.resetMultiFileState()
  }
}

module.exports = { StateManager }
