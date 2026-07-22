const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const { Md2Html, renderCRCoverPageHTML, createLocalResolver, getRepoRoot } = require('specpress')
const { buildFileContext, buildContextPreview } = require('./contextPreviewBuilder')
const { previewMultiple } = require('./multiFilePreviewBuilder')
const { applyDiff } = require('./diffRenderer')
const { logger } = require('./logger')

/** Load scroll sync script from external file */
const scrollSyncScriptPath = path.join(__dirname, 'scrollSync.js')
const scrollSyncScript = `<script>
${fs.readFileSync(scrollSyncScriptPath, 'utf8')}
</script>`


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
        if (state.isMultiFilePreview && state.restoreScrollTarget) {
          state.panel.webview.postMessage({ type: 'scrollToFile', file: state.restoreScrollTarget.file, line: state.restoreScrollTarget.line })
          state.restoreScrollTarget = null
        }
      } else if (message.type === 'scroll') {
        if (state.panel && message.headingPath) {
          state.panel.title = this.previewTitlePrefix() + ': ' + message.headingPath
        }

        if (state.currentEditor && !state.isMultiFilePreview && !state.isEditorScrolling && !state.lastFocusedIsEditor) {
          const currentFile = state.currentEditor.document.uri.fsPath
          const normalizeFile = (f) => f ? path.normalize(f).toLowerCase() : null

          if (message.sourceFile && normalizeFile(message.sourceFile) !== normalizeFile(currentFile)) return

          state.isPreviewScrolling = true
          const revealType = message.scrollingDown ? vscode.TextEditorRevealType.AtBottom : vscode.TextEditorRevealType.AtTop
          const range = new vscode.Range(message.sourceLine, 0, message.sourceLine, 0)
          state.currentEditor.revealRange(range, revealType)
          setTimeout(() => state.isPreviewScrolling = false, 150)
        }
      } else if (message.type === 'loadPrevious') {
        if (state.contextStartIdx > 0) {
          const oldScrollHeight = message.oldScrollHeight || 0
          const oldScrollTop = message.oldScrollTop || 0

          logger.log(`[LOAD_PREV] Expanding context upward, oldScrollHeight=${oldScrollHeight}, oldScrollTop=${oldScrollTop}`)

          state.contextStartIdx = Math.max(0, state.contextStartIdx - 1)
          const html = buildContextPreview(state, this.config, () => this.ensureHandler(this.config.getSpecRootForFile(state.currentEditor && state.currentEditor.document.uri.fsPath)))

          state.suppressScrollToFile = true
          state.panel.webview.html = html

          setTimeout(() => {
            if (state.panel && oldScrollHeight > 0) {
              state.panel.webview.postMessage({
                type: 'restoreScrollAfterPrepend',
                oldScrollHeight,
                oldScrollTop
              })
            }
            state.suppressScrollToFile = false
          }, 100)
        }
      } else if (message.type === 'loadNext') {
        const count = message.count || 1
        const newEndIdx = Math.min(state.contextFiles.length - 1, state.contextEndIdx + count)
        if (newEndIdx > state.contextEndIdx) {
          state.contextEndIdx = newEndIdx
          const html = buildContextPreview(state, this.config, () => this.ensureHandler(this.config.getSpecRootForFile(state.currentEditor && state.currentEditor.document.uri.fsPath)))
          state.panel.webview.html = html
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

    // Reset or initialize context window
    state.contextStartIdx = Math.max(0, currentIndex - 2)
    state.contextEndIdx = Math.min(files.length - 1, currentIndex + 2)

    state.disposeListeners()
    state.currentEditor = editor
    state.isMultiFilePreview = false
    state.lastVisibleRange = editor.visibleRanges[0] || null
    state.lastFocusedIsEditor = false
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

    // Scroll to current file and line
    setTimeout(() => {
      if (state.panel && state.currentEditor && !state.suppressScrollToFile) {
        const cursorLine = state.currentEditor.selection.active.line
        state.panel.webview.postMessage({
          type: 'scrollToFile',
          file: state.currentEditor.document.uri.fsPath,
          line: cursorLine
        })
      }
    }, 100)

    // Live update on text changes (debounced)
    let updateTimeout = null
    state.updatePreview = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === state.currentEditor.document && state.panel) {
        if (updateTimeout) clearTimeout(updateTimeout)
        updateTimeout = setTimeout(() => {
          if (!state.panel || !state.currentEditor) return
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
      if (state.panel && !state.isMultiFilePreview && !state.isPreviewScrolling
        && state.currentEditor && e.textEditor.document === state.currentEditor.document) {
        state.isEditorScrolling = true

        const visibleRange = e.visibleRanges[0]
        const prevRange = state.lastVisibleRange
        state.lastVisibleRange = visibleRange

        let sourceLine, scrollingDown
        if (prevRange && visibleRange && visibleRange.start.line > prevRange.start.line) {
          sourceLine = Math.max(0, visibleRange.end.line - 1)
          scrollingDown = true
        } else if (visibleRange) {
          sourceLine = visibleRange.start.line
          scrollingDown = false
        } else {
          return
        }

        const currentFile = state.currentEditor.document.uri.fsPath
        state.panel.webview.postMessage({
          type: 'scrollTo',
          sourceLine,
          sourceFile: currentFile,
          scrollingDown
        })
        setTimeout(() => state.isEditorScrolling = false, 150)
      }
    })

    // Switch preview when user opens a different spec file
    const editorFocusListener = vscode.window.onDidChangeActiveTextEditor(ed => {
      if (ed && state.currentEditor && ed.document === state.currentEditor.document) {
        state.currentEditor = ed
        state.lastFocusedIsEditor = true
      } else if (ed && state.panel && !state.isMultiFilePreview) {
        const newPath = ed.document.uri.fsPath
        if (this.isCRJsonFile(newPath)) {
          this.setupCRPreview(ed)
        } else {
          const isMarkdown = ed.document.languageId === 'markdown'
          const isAsn = ed.document.fileName.endsWith('.asn')
          if ((isMarkdown || isAsn) && this.config.isInsideSpecRoot(newPath)) {
            state.contextStartIdx = -1
            state.contextEndIdx = -1
            this.setupPreview(ed)
          }
        }
      }
    })

    state.panel.onDidDispose(() => {
      state.onPanelDisposed()
      editorFocusListener.dispose()
    })
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
    const editorFocusListener = vscode.window.onDidChangeActiveTextEditor(ed => {
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
      editorFocusListener.dispose()
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
