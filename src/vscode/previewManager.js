const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const { Md2Html, renderCRCoverPageHTML, createLocalResolver, getRepoRoot } = require('specpress')
const { buildFileContext, buildContextPreview } = require('./contextPreviewBuilder')
const { previewMultiple } = require('./multiFilePreviewBuilder')
const { applyDiff } = require('./diffRenderer')

/** Load scroll sync script from external file */
const scrollSyncScriptPath = path.join(__dirname, 'scrollSync.js')
const scrollSyncScript = `<script>
${fs.readFileSync(scrollSyncScriptPath, 'utf8')}
</script>`

// --- Context window tuning ---------------------------------------------------------
// The single-file live preview renders the current file plus a window of neighbours so
// the user can scroll into adjacent sections. The window is a bounded sliding window:
// when the user scrolls to an edge it slides (loading more on that side and trimming the
// far side) so every reload re-renders a bounded amount of content and stays fast.
const CONTEXT_RADIUS = 4          // neighbours rendered on each side when a file opens
const MAX_CONTEXT_WINDOW = 9      // max total files kept rendered (sliding window cap)
const CONTEXT_SLIDE_STEP = 4      // files added per edge slide (batch, not 1, to avoid
                                  // immediately re-triggering another slide)
// Delay after scrolling settles before the preview→editor cross-file switch fires.
// Opening a document mid-scroll steals the webview's wheel focus, so we debounce it.
const CROSS_FILE_SWITCH_DEBOUNCE_MS = 500


/**
 * Manages the webview preview panel, scroll synchronization, and live updates.
 */
class PreviewManager {
  /**
   * @param {import('./stateManager').StateManager} state
   * @param {import('./configLoader').ConfigLoader} config
   * @param {string} extensionDir - Absolute path to the extension root directory.
   */
  constructor(state, config, extensionDir) {
    this.state = state
    this.config = config
    this.extensionDir = extensionDir
  }

  /**
   * Builds the preview panel title prefix.
   * Format: "Live" or "Static (version)" or "Static (base vs compare)".
   */
  previewTitlePrefix() {
    const state = this.state
    if (state.isMultiFilePreview) {
      const base = state.lastMultiFileCommitRef ? state.lastMultiFileCommitRef.shortHash : null
      const compare = state.lastMultiFileBaselineRef
        ? (state.lastMultiFileBaselineRef === 'local' ? 'local' : state.lastMultiFileBaselineRef.shortHash)
        : null
      if (base && compare) return `Static (${base} vs ${compare})`
      if (base) return `Static (${base})`
      if (compare) return `Static (local vs ${compare})`
      return 'Static'
    }
    if (state.changeTrackingCommit) {
      const short = state.changeTrackingShortHash || state.changeTrackingCommit.substring(0, 7)
      return `Live (changes vs ${short})`
    }
    return 'Live'
  }

  /**
   * Creates or re-creates the Md2Html handler with current settings.
   * Uses state.currentResolver (always a FileResolver) for file existence
   * checks and URI mapping.
   * @param {string} specRoot - Spec root for section numbering.
   */
  initHandler(specRoot) {
    const resolver = this.state.currentResolver
    if (resolver && !resolver.resolveImageUri) {
      resolver.resolveImageUri = (absPath) => {
        const resolved = resolver.getAbsPath(absPath)
        return this.state.panel
          ? this.state.panel.webview.asWebviewUri(vscode.Uri.file(resolved)).toString()
          : resolved
      }
    }
    this.state.handler = new Md2Html({
      css: this.config.loadCss(this.extensionDir),
      mermaidConfig: this.config.loadMermaidConfig(),
      mscgenConfig: this.config.loadMscgenConfig ? this.config.loadMscgenConfig() : null,
      customRenderers: this.config.customRenderers,
      fileResolver: resolver || null,
      extraHeadContent: scrollSyncScript,
      specRootPath: specRoot || ''
    })
  }

  /** Ensures the handler is initialized. */
  ensureHandler(specRoot) {
    if (!this.state.handler) this.initHandler(specRoot)
  }

  /**
   * Builds the localResourceRoots array for a webview panel.
   * Uses resolver.rootDir as the single root — covers the spec tree and cached/ dir.
   * For single-file preview, also includes the change tracking baseline resolver's rootDir.
   * For multi-file preview, the baseline resolver root is added by multiFilePreviewBuilder.
   * @returns {vscode.Uri[]}
   */
  buildResourceRoots() {
    const roots = [vscode.Uri.file(this.state.currentResolver.rootDir)]
    if (this.state.changeTrackingResolver) {
      roots.push(vscode.Uri.file(this.state.changeTrackingResolver.rootDir))
    }
    return roots
  }

  /**
   * Registers the webview message handler on the panel.
   */
  registerMessageHandler() {
    const state = this.state
    state.panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'webviewReady') {
        // A reload just completed (initial load, live update, or lazy-load slide);
        // clear the context-loading guard so future slides can happen.
        state._loadingContext = false
        if (state.isMultiFilePreview && state.restoreScrollTarget) {
          state.panel.webview.postMessage({ type: 'scrollToFile', file: state.restoreScrollTarget.file, line: state.restoreScrollTarget.line })
          state.restoreScrollTarget = null
        } else if (!state.isMultiFilePreview && state.pendingScrollTarget) {
          // Deterministically position the single-file preview once the webview has
          // loaded (avoids a racy timer). Used for the initial open, live-update
          // re-anchor, and lazy-load slide restore.
          const target = state.pendingScrollTarget
          state.pendingScrollTarget = null
          // For editor-anchored targets, read the editor's current top visible line NOW:
          // webviewReady fires after setupPreview, by which time the editor view has
          // settled (e.g. when switching to an already-open file scrolled to a later
          // line). Slide/restore targets are not editor-anchored — they keep their line.
          let line = target.line
          if (target.useEditorViewport && state.currentEditor
            && state.currentEditor.document.uri.fsPath === target.file) {
            const vr = state.currentEditor.visibleRanges[0]
            if (vr) line = vr.start.line
          }
          state.panel.webview.postMessage({ type: 'scrollToFile', file: target.file, line })
        }
      } else if (message.type === 'scroll') {
        this.handleScrollMessage(message)
      } else if (message.type === 'loadPrevious') {
        this.slideContextWindow('up', message)
      } else if (message.type === 'loadNext') {
        this.slideContextWindow('down', message)
      } else if (message.type === 'ensureContentBelow') {
        // The webview could not bring a short file's target to the top for lack of
        // content below it. Extend the window downward with real files, then re-anchor
        // to the editor's top visible line. Terminates when the last file is reached.
        if (state.isMultiFilePreview || !state.currentEditor || state._loadingContext) return
        if (state.contextEndIdx < state.contextFiles.length - 1) {
          state._loadingContext = true
          state.contextEndIdx = Math.min(state.contextFiles.length - 1, state.contextEndIdx + 2)
          const vr = state.currentEditor.visibleRanges[0]
          const topLine = vr ? vr.start.line : state.currentEditor.selection.active.line
          state.pendingScrollTarget = { file: state.currentEditor.document.uri.fsPath, line: topLine, useEditorViewport: true }
          this.renderContextPreview()
        }
      } else if (message.type === 'openFile') {
        const filePath = message.sourceFile || (state.currentEditor && state.currentEditor.document.uri.fsPath)
        if (!filePath) return
        const line = message.sourceLine || 0
        vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then(doc => {
          vscode.window.showTextDocument(doc, vscode.ViewColumn.One).then(editor => {
            const pos = new vscode.Position(line, 0)
            editor.selection = new vscode.Selection(pos, pos)
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
            // Switch to live preview (same behaviour as "Edit this section")
            state.isMultiFilePreview = false
            this.setupPreview(editor)
          })
        })
      } else if (message.type === 'contextTarget') {
        state.lastContextTarget = { file: message.sourceFile, line: message.sourceLine }
      } else if (message.type === 'focus') {
        state.lastFocusedIsEditor = false
      }
    })
  }

  /**
   * Rebuilds the single-file context preview HTML into the panel.
   */
  renderContextPreview() {
    const state = this.state
    const specRootFor = () => this.config.getSpecRootForFile(
      state.currentEditor && state.currentEditor.document.uri.fsPath)
    const html = buildContextPreview(state, this.config, () => this.ensureHandler(specRootFor()))
    state.panel.webview.html = html
  }

  /**
   * Handles a 'scroll' message from the webview: updates the title and drives the
   * preview→editor sync (only when the preview, not the editor, is focused).
   * @param {object} message
   */
  handleScrollMessage(message) {
    const state = this.state
    if (state.panel && message.headingPath) {
      state.panel.title = this.previewTitlePrefix() + ': ' + message.headingPath
    }

    // Preview→editor sync is only active when the user is driving the preview (i.e. the
    // preview was clicked/focused). Skip while the editor is focused or the preview is
    // itself being scrolled programmatically.
    if (!state.currentEditor || state.isMultiFilePreview || state.editorScrollingCount || state.lastFocusedIsEditor) return

    const currentFile = state.currentEditor.document.uri.fsPath
    const normalizeFile = (f) => f ? path.normalize(f).toLowerCase() : null
    const line = Math.floor(message.sourceLine)

    if (message.sourceFile && normalizeFile(message.sourceFile) !== normalizeFile(currentFile)) {
      // Preview crossed into a different file. Opening it in the editor via
      // showTextDocument MID-SCROLL steals the webview's wheel-scroll focus and makes
      // scrolling stutter. So debounce: remember the target and only switch the editor
      // once scrolling settles (the editor "catches up" when the user pauses).
      const switchLine = Math.floor(message.midLine != null ? message.midLine : message.sourceLine)
      state._pendingCrossFileSwitch = { file: message.sourceFile, line: switchLine }
      if (state._crossFileSwitchTimer) clearTimeout(state._crossFileSwitchTimer)
      state._crossFileSwitchTimer = setTimeout(() => {
        state._crossFileSwitchTimer = null
        this.applyCrossFileSwitch()
      }, CROSS_FILE_SWITCH_DEBOUNCE_MS)
      return
    }

    // Back in / still within the current file: cancel any pending cross-file switch.
    if (state._crossFileSwitchTimer) {
      clearTimeout(state._crossFileSwitchTimer)
      state._crossFileSwitchTimer = null
      state._pendingCrossFileSwitch = null
    }

    // sourceLine may be fractional — reveal the integer part with AtTop so the editor
    // position tracks the top of the viewport, matching the webview.
    state.previewScrollingCount = (state.previewScrollingCount || 0) + 1
    const range = new vscode.Range(line, 0, line, 0)
    state.currentEditor.revealRange(range, vscode.TextEditorRevealType.AtTop)
    setTimeout(() => state.previewScrollingCount = Math.max(0, (state.previewScrollingCount || 1) - 1), 100)
  }

  /**
   * Opens the debounced cross-file target in the editor (without stealing focus or
   * rebuilding the preview) once scrolling has settled.
   */
  applyCrossFileSwitch() {
    const state = this.state
    const target = state._pendingCrossFileSwitch
    state._pendingCrossFileSwitch = null
    const normalizeFile = (f) => f ? path.normalize(f).toLowerCase() : null
    if (!target || !state.panel || state.isMultiFilePreview
      || state.lastFocusedIsEditor || !state.currentEditor) return
    if (normalizeFile(target.file) === normalizeFile(state.currentEditor.document.uri.fsPath)) return

    state._suppressPreviewRebuild = true
    vscode.workspace.openTextDocument(vscode.Uri.file(target.file)).then(doc => {
      vscode.window.showTextDocument(doc, vscode.ViewColumn.One, /* preserveFocus */ true).then(ed => {
        state.currentEditor = ed
        state.previewScrollingCount = (state.previewScrollingCount || 0) + 1
        const range = new vscode.Range(target.line, 0, target.line, 0)
        ed.revealRange(range, vscode.TextEditorRevealType.AtTop)
        setTimeout(() => {
          state.previewScrollingCount = Math.max(0, (state.previewScrollingCount || 1) - 1)
          state._suppressPreviewRebuild = false
        }, 100)
      })
    }).catch(() => { state._suppressPreviewRebuild = false })
  }

  /**
   * Slides the bounded context window one step in the given direction and re-anchors the
   * preview to the current top-of-viewport source line after the reload.
   * @param {'up'|'down'} direction
   * @param {object} message - carries the webview's current top { sourceFile, sourceLine }
   */
  slideContextWindow(direction, message) {
    const state = this.state
    // Serialize context reloads (one at a time) — cleared on webviewReady.
    if (state._loadingContext) return

    if (direction === 'up') {
      if (state.contextStartIdx <= 0) return
      state._loadingContext = true
      state.contextStartIdx = Math.max(0, state.contextStartIdx - CONTEXT_SLIDE_STEP)
      // Trim the far (bottom) end so the rendered document stays bounded (fast reloads).
      if (state.contextEndIdx - state.contextStartIdx + 1 > MAX_CONTEXT_WINDOW) {
        state.contextEndIdx = state.contextStartIdx + MAX_CONTEXT_WINDOW - 1
      }
    } else {
      const last = state.contextFiles.length - 1
      if (state.contextEndIdx >= last) return
      state._loadingContext = true
      state.contextEndIdx = Math.min(last, state.contextEndIdx + CONTEXT_SLIDE_STEP)
      // Trim the far (top) end.
      if (state.contextEndIdx - state.contextStartIdx + 1 > MAX_CONTEXT_WINDOW) {
        state.contextStartIdx = state.contextEndIdx - MAX_CONTEXT_WINDOW + 1
      }
    }

    // Anchor-based restore: reposition to the same top-of-viewport source line after the
    // reload. Works even though the far end was trimmed (unlike pixel-based restore).
    if (message.sourceFile != null) {
      state.pendingScrollTarget = { file: message.sourceFile, line: Math.floor(message.sourceLine || 0) }
    }
    this.renderContextPreview()
  }

  /**
   * Checks if a file is a CR JSON file (CRxxxx.json or CR####.json in a history/ folder).
   * @param {string} filePath
   * @returns {boolean}
   */
  isCRJsonFile(filePath) {
    const basename = path.basename(filePath)
    const dir = path.basename(path.dirname(filePath))
    return dir.toLowerCase() === 'history' && /^CR[x\d]{4}\.json$/i.test(basename)
  }

  /**
   * Whether a document is a SpecPress preview source (markdown, ASN.1, or a CR JSON file).
   * @param {import('vscode').TextDocument} document
   * @returns {boolean}
   */
  isPreviewSource(document) {
    const p = document.uri.fsPath
    return document.languageId === 'markdown' || p.endsWith('.asn') || this.isCRJsonFile(p)
  }

  /**
   * Builds a preview HTML for a CR JSON file.
   * @param {string} filePath - Path to the CR JSON file.
   * @param {string} [content] - Optional file content (for unsaved edits).
   * @returns {string} Complete HTML document.
   */
  buildCRPreviewHtml(filePath, content) {
    try {
      const text = content || fs.readFileSync(filePath, 'utf8')
      const data = JSON.parse(text)
      const crHtml = renderCRCoverPageHTML(data)
      if (!crHtml) return '<html><body><p>Invalid CR cover page data</p></body></html>'
      this.ensureHandler()
      return this.state.handler.wrapHtml(crHtml)
    } catch (e) {
      return `<html><body><pre style="color:red">${e.message}</pre></body></html>`
    }
  }

  /**
   * Sets up or updates the preview panel for a given editor.
   * @param {vscode.TextEditor} editor - The editor whose document to preview.
   */
  setupPreview(editor) {
    if (!editor) return
    const filePath = editor.document.uri.fsPath
    const isMarkdown = editor.document.languageId === 'markdown'
    const isAsn = filePath.endsWith('.asn')
    const isCR = this.isCRJsonFile(filePath)
    if (!isMarkdown && !isAsn && !isCR) return
    if (!isCR && !this.config.isInsideSpecRoot(filePath)) return

    // CR JSON files get a dedicated simple preview
    if (isCR) {
      this.setupCRPreview(editor)
      return
    }

    const state = this.state

    // Build file context (current + neighbors)
    const { files, currentIndex } = buildFileContext(this.config, filePath)
    state.contextFiles = files
    state.currentFileIndex = currentIndex

    // Reset or initialize the bounded context window around the current file.
    state.contextStartIdx = Math.max(0, currentIndex - CONTEXT_RADIUS)
    state.contextEndIdx = Math.min(files.length - 1, currentIndex + CONTEXT_RADIUS)

    state.disposeListeners()
    state.currentEditor = editor
    state.isMultiFilePreview = false
    // Opening/activating a file focuses the editor, not the preview. Keep the
    // preview→editor scroll sync OFF until the user explicitly clicks the preview
    // (which sends a 'focus' message that flips this to false).
    state.lastFocusedIsEditor = true
    vscode.commands.executeCommand('setContext', 'specpress.isMultiFilePreview', false)

    // Recreate the panel when localResourceRoots need to change (change tracking
    // toggled, or no panel exists yet). Reuse the existing panel for normal file switches
    // to avoid focus disruption and disposal cascades.
    const needNewPanel = !state.panel || state.panel._changeTrackingActive !== !!state.changeTrackingCommit
    if (needNewPanel) {
      if (state.panel) {
        state._replacingPanel = true
        state.panel.dispose()
        state._replacingPanel = false
        state.panel = null
      }

      // Create a local resolver so all file access goes through FileResolver uniformly
      const specRoot = this.config.findSpecRootFor(filePath) || this.config.wsRoot || path.dirname(filePath)
      let repoRoot = specRoot
      try { repoRoot = getRepoRoot(specRoot) } catch (e) { /* not a git repo */ }
      state.currentResolver = createLocalResolver(repoRoot, specRoot)

      state.panel = vscode.window.createWebviewPanel('specpressPreview', 'Preview',
        vscode.ViewColumn.Beside, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: this.buildResourceRoots()
        })
      state.panel._changeTrackingActive = !!state.changeTrackingCommit
      // Remember the panel's column while it is visible (it becomes undefined once the
      // panel is hidden), so we can detect editors that later cover it.
      if (state.panel.viewColumn) state.previewViewColumn = state.panel.viewColumn
      state.panel.onDidChangeViewState(() => {
        const panel = state.panel
        if (!panel) return
        if (panel.viewColumn) state.previewViewColumn = panel.viewColumn
        // The active-editor event does NOT fire when a file opens over a focused webview,
        // but this view-state event does. If the preview became hidden and a source
        // editor now occupies its column, that editor is covering it — relocate it to the
        // other column (and update the preview to the newly opened file, since the
        // active-editor event won't).
        if (!panel.visible) {
          this.relocateActiveEditorOffPreviewColumn({ reSetupPreview: true })
        }
      })
      state.panel.onDidDispose(() => state.onPanelDisposed())
      this.registerMessageHandler()

      // Set resolveImageUri on changeTrackingResolver now that the panel exists
      if (state.changeTrackingResolver) {
        const ctResolver = state.changeTrackingResolver
        ctResolver.resolveImageUri = (absPath) =>
          state.panel.webview.asWebviewUri(vscode.Uri.file(ctResolver.getAbsPath(absPath))).toString()
      }

      // Reinitialize handler so resolveImageUri closure captures the new panel and resolver
      state.handler = null
      this.ensureHandler(this.config.getSpecRootForFile(filePath))

      // Refocus editor after panel creation
      setTimeout(() => {
        vscode.window.showTextDocument(editor.document, editor.viewColumn, false)
      }, 100)
    } else {
      const specRoot = this.config.findSpecRootFor(filePath) || this.config.wsRoot || path.dirname(filePath)
      let repoRoot = specRoot
      try { repoRoot = getRepoRoot(specRoot) } catch (e) { /* not a git repo */ }
      state.currentResolver = createLocalResolver(repoRoot, specRoot)
      this.ensureHandler(this.config.getSpecRootForFile(filePath))
    }

    // Render context preview
    const html = buildContextPreview(state, this.config, () => this.ensureHandler(this.config.getSpecRootForFile(filePath)))
    state.panel.webview.html = html
    state.panel.title = this.previewTitlePrefix()

    // Position the preview once the webview is ready (see webviewReady handler). Use the
    // editor's top VISIBLE line rather than the cursor line, so switching to an
    // already-open file that was scrolled to a later position shows that position.
    if (state.currentEditor) {
      const vr = state.currentEditor.visibleRanges[0]
      const topLine = vr ? vr.start.line : state.currentEditor.selection.active.line
      state.pendingScrollTarget = {
        file: state.currentEditor.document.uri.fsPath,
        line: topLine,
        useEditorViewport: true
      }
    }

    // Live update on text changes (debounced)
    let updateTimeout = null
    state.updatePreview = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === state.currentEditor.document && state.panel) {
        // Editing means the editor is focused — keep preview→editor sync OFF so the
        // live-update reload below can't drag the editor to a neighbouring file.
        state.lastFocusedIsEditor = true
        if (updateTimeout) clearTimeout(updateTimeout)
        updateTimeout = setTimeout(() => {
          if (!state.panel || !state.currentEditor) return
          // Reassigning webview.html reloads the webview and resets its scroll to the
          // top (a preceding context file). Re-anchor the preview to the editor's
          // current top-of-viewport line so it stays where the user is editing.
          const vr = state.currentEditor.visibleRanges[0]
          const topLine = vr ? vr.start.line : state.currentEditor.selection.active.line
          state.pendingScrollTarget = {
            file: state.currentEditor.document.uri.fsPath,
            line: topLine,
            useEditorViewport: true
          }
          const html = buildContextPreview(state, this.config, () => this.ensureHandler(this.config.getSpecRootForFile(state.currentEditor.document.uri.fsPath)))
          state.panel.webview.html = html
        }, 500)
      }
    })

    // Re-render on file save (adjacent files or JSON)
    state.fileSaveListener = vscode.workspace.onDidSaveTextDocument(doc => {
      if (!state.panel || state.isMultiFilePreview) return
      if (!state.currentEditor) return

      const savedPath = doc.uri.fsPath
      if (state.contextFiles.includes(savedPath) || doc.fileName.endsWith('.json')) {
        state.adjacentFileCache.delete(savedPath)
        const html = buildContextPreview(state, this.config, () => this.ensureHandler(this.config.getSpecRootForFile(state.currentEditor.document.uri.fsPath)))
        state.panel.webview.html = html
      }
    })

    // Scroll sync: editor → preview
    state.scrollSync = vscode.window.onDidChangeTextEditorVisibleRanges(e => {
      if (state.panel && !state.isMultiFilePreview && !state.previewScrollingCount
        && state.currentEditor && e.textEditor.document === state.currentEditor.document) {
        // A genuine editor scroll (not driven by the preview) implies the editor is the
        // focused pane — keep preview→editor sync OFF until the user clicks the preview.
        state.lastFocusedIsEditor = true
        state.editorScrollingCount = (state.editorScrollingCount || 0) + 1

        const visibleRange = e.visibleRanges[0]
        if (!visibleRange) {
          state.editorScrollingCount = Math.max(0, (state.editorScrollingCount || 1) - 1)
          return
        }

        // Send a fractional line: start line + fraction of the first visible line
        // that has scrolled past the top. VS Code doesn't expose sub-line fractions
        // directly, so we use start.line as the top-of-viewport line.
        const sourceLine = visibleRange.start.line
        const currentFile = state.currentEditor.document.uri.fsPath
        state.panel.webview.postMessage({
          type: 'scrollTo',
          sourceLine,
          sourceFile: currentFile
        })
        setTimeout(() => state.editorScrollingCount = Math.max(0, (state.editorScrollingCount || 1) - 1), 100)
      }
    })

    // Cursor/selection changes in the current editor mean the user clicked back into
    // the editor. Returning focus from the webview to the editor does NOT fire
    // onDidChangeActiveTextEditor (the active text editor never changed), so this is
    // the signal that re-enables the "editor is focused" state and stops the
    // preview→editor sync from dragging the editor.
    state.selectionSync = vscode.window.onDidChangeTextEditorSelection(e => {
      if (state.panel && !state.isMultiFilePreview && !state.previewScrollingCount
        && state.currentEditor && e.textEditor.document === state.currentEditor.document) {
        state.lastFocusedIsEditor = true
      }
    })

    // Switch preview when the user opens a different spec file.
    // Stored on state (and disposed via disposeListeners) so repeated setupPreview calls
    // on file switches don't accumulate duplicate listeners.
    state.editorFocusListener = vscode.window.onDidChangeActiveTextEditor(ed => {
      if (!ed) return

      // Keep the preview's column up to date whenever it is currently visible.
      if (state.panel && state.panel.viewColumn) state.previewViewColumn = state.panel.viewColumn

      // If a source editor became active in the preview's column, it is covering the
      // preview — relocate it (fallback for cases where this event does fire; the primary
      // path is the panel's onDidChangeViewState). If we relocated, the move re-fires this
      // event with the editor in its new column, which then runs the setup below.
      if (this.relocateActiveEditorOffPreviewColumn({ reSetupPreview: false, editor: ed })) return

      if (state.currentEditor && ed.document === state.currentEditor.document) {
        state.currentEditor = ed
        state.lastFocusedIsEditor = true
      } else if (state.panel && !state.isMultiFilePreview && !state._suppressPreviewRebuild) {
        const newPath = ed.document.uri.fsPath
        if (this.isCRJsonFile(newPath)) {
          this.setupCRPreview(ed)
        } else if (this.isPreviewSource(ed.document) && this.config.isInsideSpecRoot(newPath)) {
          state.contextStartIdx = -1
          state.contextEndIdx = -1
          this.setupPreview(ed)
        }
      }
    })

    state.panel.onDidDispose(() => {
      state.onPanelDisposed()
    })
  }

  /**
   * If a source editor is currently active in the preview panel's column, it is covering
   * the preview; move it to the other column so the preview stays visible.
   *
   * VS Code doesn't let us intercept the Explorer open beforehand, so we react afterwards.
   * We compare against the TRACKED preview column because the panel's own viewColumn is
   * undefined while it is hidden behind the editor.
   *
   * @param {{reSetupPreview: boolean, editor?: import('vscode').TextEditor}} opts
   *   reSetupPreview - after moving, refresh the preview to the newly opened file (needed
   *     when driven by onDidChangeViewState, since the active-editor event won't fire).
   *   editor - the editor to consider (defaults to the active text editor).
   * @returns {boolean} true if a relocation was initiated.
   */
  relocateActiveEditorOffPreviewColumn({ reSetupPreview, editor } = {}) {
    const state = this.state
    const ed = editor || vscode.window.activeTextEditor
    if (!state.panel || state.isMultiFilePreview || state._relocatingEditor) return false
    if (!ed || !ed.viewColumn || !state.previewViewColumn || ed.viewColumn !== state.previewViewColumn) return false
    if (!this.isPreviewSource(ed.document)) return false

    state._relocatingEditor = true
    const moveCmd = state.previewViewColumn === vscode.ViewColumn.One
      ? 'workbench.action.moveEditorToRightGroup'
      : 'workbench.action.moveEditorToLeftGroup'
    Promise.resolve(vscode.commands.executeCommand(moveCmd)).then(() => {
      if (reSetupPreview) {
        const ae = vscode.window.activeTextEditor
        if (ae && (!state.currentEditor || ae.document !== state.currentEditor.document)) {
          const np = ae.document.uri.fsPath
          if (this.isCRJsonFile(np)) {
            this.setupCRPreview(ae)
          } else if (this.isPreviewSource(ae.document) && this.config.isInsideSpecRoot(np)) {
            state.contextStartIdx = -1
            state.contextEndIdx = -1
            this.setupPreview(ae)
          }
        }
      }
      setTimeout(() => { state._relocatingEditor = false }, 300)
    }, () => { state._relocatingEditor = false })
    return true
  }

  /**
   * Sets up a live preview for a CR JSON file.
   * @param {vscode.TextEditor} editor
   */
  setupCRPreview(editor) {
    const state = this.state
    const filePath = editor.document.uri.fsPath

    state.disposeListeners()
    state.currentEditor = editor
    state.isMultiFilePreview = false
    vscode.commands.executeCommand('setContext', 'specpress.isMultiFilePreview', false)

    if (!state.panel) {
      const resourceRoot = path.dirname(filePath)
      state.panel = vscode.window.createWebviewPanel('specpressPreview', 'Preview: CR Cover Page',
        vscode.ViewColumn.Beside, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(resourceRoot)]
        })
      state.panel.onDidDispose(() => state.onPanelDisposed())
    } else {
      state.panel.title = 'Preview: CR Cover Page'
    }

    state.panel.webview.html = this.buildCRPreviewHtml(filePath, editor.document.getText())

    // Live update on text changes
    let updateTimeout = null
    state.updatePreview = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === editor.document && state.panel) {
        if (updateTimeout) clearTimeout(updateTimeout)
        updateTimeout = setTimeout(() => {
          if (!state.panel) return
          state.panel.webview.html = this.buildCRPreviewHtml(filePath, e.document.getText())
        }, 500)
      }
    })

    // Switch away when user opens a different file
    state.editorFocusListener = vscode.window.onDidChangeActiveTextEditor(ed => {
      if (ed && ed !== editor && state.panel) {
        const newPath = ed.document.uri.fsPath
        if (this.isCRJsonFile(newPath)) {
          this.setupCRPreview(ed)
        } else {
          const isMd = ed.document.languageId === 'markdown'
          const isAsn = newPath.endsWith('.asn')
          if ((isMd || isAsn) && this.config.isInsideSpecRoot(newPath)) {
            this.setupPreview(ed)
          }
        }
      }
    })

    state.panel.onDidDispose(() => {
      state.onPanelDisposed()
    })
  }

  /**
   * Builds and displays a multi-file preview.
   * Delegates to multiFilePreviewBuilder.
   */
  async previewMultiple(uris, commitRef, baselineRef) {
    await previewMultiple(
      this.state, this.config,
      (specRoot) => this.ensureHandler(specRoot),
      () => this.registerMessageHandler(),
      () => this.buildResourceRoots(),
      uris, commitRef, baselineRef
    )
  }
}

module.exports = { PreviewManager, scrollSyncScript }
