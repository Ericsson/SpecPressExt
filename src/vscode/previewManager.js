const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const { Md2Html } = require('specpress/lib/md2html/md2html')
const { buildFrontPageHtml } = require('specpress/lib/md2html/frontPage')
const { renderCRCoverPageHTML } = require('specpress/lib/md2html/crCoverPageRenderer')
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

  /** Creates or re-creates the Md2Html handler with current settings. */
  initHandler() {
    const specRoot = this.state.currentEditor
      ? this.config.getSpecRootForFile(this.state.currentEditor.document.uri.fsPath)
      : (this.state.lastMultiFileUris && this.state.lastMultiFileUris.length > 0
        ? this.config.getSpecRootForFile(this.state.lastMultiFileUris[0].fsPath)
        : null)

    this.state.handler = new Md2Html({
      css: this.config.loadCss(this.extensionDir),
      mermaidConfig: this.config.loadMermaidConfig(),
      frontPageHtml: buildFrontPageHtml(this.config.loadFrontPageData()),
      customRenderers: this.config.customRenderers,
      resolveImageUri: (absPath) => this.state.panel ? this.state.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString() : absPath,
      extraHeadContent: scrollSyncScript,
      specRootPath: specRoot
    })
  }

  /** Ensures the handler is initialized. */
  ensureHandler() {
    if (!this.state.handler) this.initHandler()
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
          const prefix = state.changeTrackingCommit ? 'Preview (changes): ' : 'Preview: '
          state.panel.title = prefix + message.headingPath
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
          const html = buildContextPreview(state, this.config, () => this.ensureHandler())

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
          const html = buildContextPreview(state, this.config, () => this.ensureHandler())
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
          })
        })
      } else if (message.type === 'contextTarget') {
        state.lastContextTarget = { file: message.sourceFile, line: message.sourceLine }
      } else if (message.type === 'focus') {
        state.lastFocusedIsEditor = false
        if (!state.isMultiFilePreview) {
          const ed = state.currentEditor || vscode.window.activeTextEditor
          if (ed) vscode.window.showTextDocument(ed.document, ed.viewColumn, false)
        }
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

    const isNewPanel = !state.panel

    if (!state.panel) {
      const resourceRoot = this.config.findSpecRootFor(editor.document.uri.fsPath)
        || this.config.wsRoot
        || path.dirname(editor.document.uri.fsPath)
      state.panel = vscode.window.createWebviewPanel('specpressPreview', 'Preview',
        vscode.ViewColumn.Beside, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(resourceRoot)]
        })
      state.panel.onDidDispose(() => state.onPanelDisposed())
      this.registerMessageHandler()
    }

    // Render context preview
    const html = buildContextPreview(state, this.config, () => this.ensureHandler())
    state.panel.webview.html = html
    const prefix = state.changeTrackingCommit ? 'Preview (changes)' : 'Preview'
    state.panel.title = prefix

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

    if (isNewPanel) {
      setTimeout(() => {
        vscode.window.showTextDocument(editor.document, editor.viewColumn, false)
      }, 100)
    }

    // Live update on text changes (debounced)
    let updateTimeout = null
    state.updatePreview = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === state.currentEditor.document && state.panel) {
        if (updateTimeout) clearTimeout(updateTimeout)
        updateTimeout = setTimeout(() => {
          if (!state.panel || !state.currentEditor) return
          const html = buildContextPreview(state, this.config, () => this.ensureHandler())
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
        const html = buildContextPreview(state, this.config, () => this.ensureHandler())
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
  async previewMultiple(uris, commitRef) {
    await previewMultiple(
      this.state, this.config,
      () => this.ensureHandler(),
      () => this.registerMessageHandler(),
      uris, commitRef
    )
  }
}

module.exports = { PreviewManager, scrollSyncScript }
