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
        // A reload just completed (initial load, live update, or lazy-load slide);
        // clear the context-loading guard so future slides can happen.
        state._loadingContext = false
        if (state.isMultiFilePreview && state.restoreScrollTarget) {
          state.panel.webview.postMessage({ type: 'scrollToFile', file: state.restoreScrollTarget.file, line: state.restoreScrollTarget.line })
          state.restoreScrollTarget = null
        } else if (!state.isMultiFilePreview && state.pendingScrollTarget && !state.suppressScrollToFile) {
          // Deterministically position the single-file preview once the webview has
          // loaded (replaces the racy setTimeout-based scrollToFile). Used both for the
          // initial open and to re-anchor after a live-update reload.
          const target = state.pendingScrollTarget
          state.pendingScrollTarget = null
          // The editor may only finish restoring its scroll position AFTER setupPreview
          // ran (e.g. switching to an already-open file scrolled to a later line). For
          // editor-anchored targets, read its current top visible line now — webviewReady
          // fires later, by which time the editor view has settled — so the preview opens
          // at the right place instead of the top. (loadNext targets are NOT editor-based:
          // they preserve the preview's own scroll position, so they keep their line.)
          let line = target.line
          if (target.useEditorViewport && state.currentEditor
            && state.currentEditor.document.uri.fsPath === target.file) {
            const vr = state.currentEditor.visibleRanges[0]
            if (vr) line = vr.start.line
          }
          state.panel.webview.postMessage({ type: 'scrollToFile', file: target.file, line })
        }
      } else if (message.type === 'scroll') {
        if (state.panel && message.headingPath) {
          state.panel.title = this.previewTitlePrefix() + ': ' + message.headingPath
        }

        if (state.currentEditor && !state.isMultiFilePreview && !state.editorScrollingCount && !state.lastFocusedIsEditor) {
          const currentFile = state.currentEditor.document.uri.fsPath
          const normalizeFile = (f) => f ? path.normalize(f).toLowerCase() : null
          const line = Math.floor(message.sourceLine)

          if (message.sourceFile && normalizeFile(message.sourceFile) !== normalizeFile(currentFile)) {
            // Preview crossed into a different file. Opening it in the editor via
            // showTextDocument MID-SCROLL steals the webview's wheel-scroll focus and
            // makes scrolling stutter. So debounce it: remember the target and only
            // switch the editor once scrolling has settled (the editor "catches up" when
            // the user pauses). The cheap same-file reveal below stays live meanwhile.
            const switchLine = Math.floor(message.midLine != null ? message.midLine : message.sourceLine)
            const prev = state._pendingCrossFileSwitch
            state._pendingCrossFileSwitch = { file: message.sourceFile, line: switchLine }
            if (!prev || prev.file !== message.sourceFile) {
              logger.log('[XFILE] schedule switch', { to: path.basename(message.sourceFile), line: switchLine, from: path.basename(currentFile) })
            }
            if (state._crossFileSwitchTimer) clearTimeout(state._crossFileSwitchTimer)
            state._crossFileSwitchTimer = setTimeout(() => {
              state._crossFileSwitchTimer = null
              const target = state._pendingCrossFileSwitch
              state._pendingCrossFileSwitch = null
              logger.log('[XFILE] timer fired -> executing switch', { target: target ? path.basename(target.file) : null })
              if (!target || !state.panel || state.isMultiFilePreview
                || state.lastFocusedIsEditor || !state.currentEditor) return
              if (normalizeFile(target.file) === normalizeFile(state.currentEditor.document.uri.fsPath)) return
              state._suppressPreviewRebuild = true
              vscode.workspace.openTextDocument(vscode.Uri.file(target.file)).then(doc => {
                vscode.window.showTextDocument(doc, vscode.ViewColumn.One, /* preserveFocus */ true).then(ed => {
                  logger.log('[XFILE] editor shown', { file: path.basename(target.file), line: target.line, edColumn: ed.viewColumn })
                  state.currentEditor = ed
                  state.previewScrollingCount = (state.previewScrollingCount || 0) + 1
                  const range = new vscode.Range(target.line, 0, target.line, 0)
                  ed.revealRange(range, vscode.TextEditorRevealType.AtTop)
                  setTimeout(() => {
                    state.previewScrollingCount = Math.max(0, (state.previewScrollingCount || 1) - 1)
                    state._suppressPreviewRebuild = false
                  }, 100)
                })
              }).catch((err) => {
                logger.log('[XFILE] open/show FAILED', { error: String(err) })
                state._suppressPreviewRebuild = false
              })
            }, 500)
            return
          }

          // Back in / still within the current file: cancel any pending cross-file switch.
          if (state._crossFileSwitchTimer) {
            clearTimeout(state._crossFileSwitchTimer)
            state._crossFileSwitchTimer = null
            state._pendingCrossFileSwitch = null
          }

          state.previewScrollingCount = (state.previewScrollingCount || 0) + 1
          // sourceLine may be fractional — reveal the integer part with AtTop so the
          // editor position tracks the top of the viewport, matching the webview.
          const range = new vscode.Range(line, 0, line, 0)
          state.currentEditor.revealRange(range, vscode.TextEditorRevealType.AtTop)
          setTimeout(() => state.previewScrollingCount = Math.max(0, (state.previewScrollingCount || 1) - 1), 100)
        }
      } else if (message.type === 'loadPrevious') {
        logger.log('[LOAD_PREV] received', { contextStartIdx: state.contextStartIdx, contextEndIdx: state.contextEndIdx, willLoad: state.contextStartIdx > 0, inProgress: !!state._loadingContext })
        // Serialize context reloads (one at a time) — cleared on webviewReady.
        if (state._loadingContext) return
        if (state.contextStartIdx > 0) {
          state._loadingContext = true
          const STEP = 4
          const MAX_WINDOW = 9
          state.contextStartIdx = Math.max(0, state.contextStartIdx - STEP)
          // Slide the window: trim the far (bottom) end so the rendered document stays a
          // bounded size. Without this the window grows unboundedly and each reload has to
          // re-render an ever-larger document (+ all its mermaid), so reloads balloon from
          // ~0.5s to many seconds. A bounded window keeps every reload fast and consistent.
          // Sliding by a batch (not 1) leaves a buffer above the anchor so we don't
          // immediately re-trigger another slide.
          if (state.contextEndIdx - state.contextStartIdx + 1 > MAX_WINDOW) {
            state.contextEndIdx = state.contextStartIdx + MAX_WINDOW - 1
          }
          // Anchor-based restore: reposition to the same top-of-viewport source line after
          // the reload. This works even though the bottom was trimmed (unlike the old
          // pixel-based restore, which assumed the bottom was unchanged).
          if (message.sourceFile != null) {
            state.pendingScrollTarget = { file: message.sourceFile, line: Math.floor(message.sourceLine || 0) }
          }
          const html = buildContextPreview(state, this.config, () => this.ensureHandler(this.config.getSpecRootForFile(state.currentEditor && state.currentEditor.document.uri.fsPath)))
          state.panel.webview.html = html
        }
      } else if (message.type === 'loadNext') {
        const count = message.count || 1
        const newEndIdx = Math.min(state.contextFiles.length - 1, state.contextEndIdx + count)
        logger.log('[LOAD_NEXT] received', { contextStartIdx: state.contextStartIdx, contextEndIdx: state.contextEndIdx, newEndIdx, willLoad: newEndIdx > state.contextEndIdx, inProgress: !!state._loadingContext })
        // Serialize context reloads (one at a time) — cleared on webviewReady.
        if (state._loadingContext) return
        if (newEndIdx > state.contextEndIdx) {
          state._loadingContext = true
          const STEP = 4
          const MAX_WINDOW = 9
          state.contextEndIdx = Math.min(state.contextFiles.length - 1, state.contextEndIdx + STEP)
          // Slide the window: trim the far (top) end to keep it bounded (see loadPrevious).
          if (state.contextEndIdx - state.contextStartIdx + 1 > MAX_WINDOW) {
            state.contextStartIdx = state.contextEndIdx - MAX_WINDOW + 1
          }
          // Anchor-based restore to the current top-of-viewport source line.
          if (message.sourceFile != null) {
            state.pendingScrollTarget = { file: message.sourceFile, line: Math.floor(message.sourceLine || 0) }
          }
          const html = buildContextPreview(state, this.config, () => this.ensureHandler(this.config.getSpecRootForFile(state.currentEditor && state.currentEditor.document.uri.fsPath)))
          state.panel.webview.html = html
        }
      } else if (message.type === 'ensureContentBelow') {
        // The webview reported it could not bring the target to the top because there
        // isn't a full viewport of content below it (a short file whose few following
        // files are also short). Extend the context window downward with real files so
        // the target can reach the top, then re-anchor to the editor's top visible line.
        // Terminates naturally once contextEndIdx reaches the last file.
        if (state.isMultiFilePreview || !state.currentEditor) return
        if (state._loadingContext) return
        if (state.contextEndIdx < state.contextFiles.length - 1) {
          state._loadingContext = true
          state.contextEndIdx = Math.min(state.contextFiles.length - 1, state.contextEndIdx + 2)
          const vr = state.currentEditor.visibleRanges[0]
          const topLine = vr ? vr.start.line : state.currentEditor.selection.active.line
          state.pendingScrollTarget = { file: state.currentEditor.document.uri.fsPath, line: topLine, useEditorViewport: true }
          const html = buildContextPreview(state, this.config, () => this.ensureHandler(this.config.getSpecRootForFile(state.currentEditor.document.uri.fsPath)))
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
    // Initial context window radius. A larger radius means moderate up/down scrolling
    // stays within pre-rendered content, avoiding the full-reload lazy-load (which drops
    // the wheel gesture and briefly "locks" the preview). Kept bounded so the initial
    // render and live-update rebuilds stay fast (source files can be large).
    state.contextStartIdx = Math.max(0, currentIndex - 4)
    state.contextEndIdx = Math.min(files.length - 1, currentIndex + 4)

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
      // panel is hidden), so we can detect and relocate editors that cover it.
      if (state.panel.viewColumn) state.previewViewColumn = state.panel.viewColumn
      logger.log('[RELOC] panel created', { initialViewColumn: state.panel.viewColumn, trackedColumn: state.previewViewColumn })
      state.panel.onDidChangeViewState(() => {
        const panel = state.panel
        if (!panel) return
        if (panel.viewColumn) state.previewViewColumn = panel.viewColumn

        const ate = vscode.window.activeTextEditor
        let layout = null
        try {
          if (vscode.window.tabGroups) {
            layout = {
              activeGroupCol: vscode.window.tabGroups.activeTabGroup ? vscode.window.tabGroups.activeTabGroup.viewColumn : null,
              groups: vscode.window.tabGroups.all.map(g => ({
                col: g.viewColumn,
                active: g.isActive,
                activeTab: g.activeTab ? g.activeTab.label : null,
                inputKind: g.activeTab && g.activeTab.input ? g.activeTab.input.constructor.name : null
              }))
            }
          }
        } catch (e) { layout = { error: String(e) } }

        logger.log('[RELOC] panel view state changed', {
          viewColumn: panel.viewColumn,
          visible: panel.visible,
          active: panel.active,
          trackedColumn: state.previewViewColumn,
          relocatingEditor: !!state._relocatingEditor,
          activeTextEditorFile: ate ? ate.document.uri.fsPath : null,
          activeTextEditorCol: ate ? ate.viewColumn : null,
          layout
        })

        // The active-editor event does NOT fire when a file opens over a focused webview,
        // but this view-state event does. If the preview became hidden and a source
        // editor now occupies its column, that editor is covering the preview — relocate
        // it to the other column so the preview stays visible.
        if (!panel.visible && !state.isMultiFilePreview && !state._relocatingEditor
          && ate && state.previewViewColumn && ate.viewColumn === state.previewViewColumn) {
          const p = ate.document.uri.fsPath
          const isSource = ate.document.languageId === 'markdown' || p.endsWith('.asn') || this.isCRJsonFile(p)
          logger.log('[RELOC] preview hidden with source editor in its column', { isSource, file: p })
          if (isSource) {
            state._relocatingEditor = true
            const moveCmd = state.previewViewColumn === vscode.ViewColumn.One
              ? 'workbench.action.moveEditorToRightGroup'
              : 'workbench.action.moveEditorToLeftGroup'
            logger.log('[RELOC] (viewState) executing move', { moveCmd, previewViewColumn: state.previewViewColumn })
            Promise.resolve(vscode.commands.executeCommand(moveCmd)).then(() => {
              const ae = vscode.window.activeTextEditor
              logger.log('[RELOC] (viewState) move resolved', {
                panelVisibleAfter: state.panel ? state.panel.visible : null,
                activeEditorColAfter: ae ? ae.viewColumn : null,
                activeEditorFileAfter: ae ? ae.document.uri.fsPath : null
              })
              // Ensure the preview reflects the newly opened file (the active-editor event
              // may not have fired for a file opened over the webview).
              if (ae && (!state.currentEditor || ae.document !== state.currentEditor.document)) {
                const np = ae.document.uri.fsPath
                if (this.isCRJsonFile(np)) {
                  this.setupCRPreview(ae)
                } else if ((ae.document.languageId === 'markdown' || np.endsWith('.asn'))
                  && this.config.isInsideSpecRoot(np)) {
                  state.contextStartIdx = -1
                  state.contextEndIdx = -1
                  this.setupPreview(ae)
                }
              }
              setTimeout(() => { state._relocatingEditor = false }, 300)
            }, (err) => {
              logger.log('[RELOC] (viewState) move REJECTED', { error: String(err) })
              state._relocatingEditor = false
            })
          }
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

    // Scroll to current file and line — set a pending target that is applied
    // deterministically once the webview reports 'webviewReady' (avoids the race
    // where a fixed timer fires before layout/mermaid settle or after the load-time
    // scroll event has already triggered edge lazy-loading).
    // Use the editor's top VISIBLE line (not the cursor line): when switching to an
    // already-open file that was scrolled to a later position, the cursor is often
    // still at line 0, which would incorrectly show the top of the file.
    if (!state.suppressScrollToFile && state.currentEditor) {
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

    // Switch preview when user opens a different spec file.
    // Stored on state (and disposed via disposeListeners) so repeated setupPreview calls
    // on file switches don't accumulate duplicate listeners.
    state.editorFocusListener = vscode.window.onDidChangeActiveTextEditor(ed => {
      if (!ed) {
        logger.log('[RELOC] onDidChangeActiveTextEditor fired with no editor (ed=null)')
        return
      }

      // Keep the preview's column up to date whenever it is currently visible.
      if (state.panel && state.panel.viewColumn) state.previewViewColumn = state.panel.viewColumn

      let layoutInfo = null
      try {
        if (vscode.window.tabGroups) {
          layoutInfo = {
            activeGroupViewColumn: vscode.window.tabGroups.activeTabGroup
              ? vscode.window.tabGroups.activeTabGroup.viewColumn : null,
            groups: vscode.window.tabGroups.all.map(g => ({
              viewColumn: g.viewColumn,
              active: g.isActive,
              activeTabLabel: g.activeTab ? g.activeTab.label : null,
              tabCount: g.tabs.length
            }))
          }
        }
      } catch (e) { layoutInfo = { error: String(e) } }

      logger.log('[RELOC] active editor changed', {
        edFile: ed.document.uri.fsPath,
        edViewColumn: ed.viewColumn,
        panelExists: !!state.panel,
        panelViewColumnLive: state.panel ? state.panel.viewColumn : null,
        panelVisible: state.panel ? state.panel.visible : null,
        previewViewColumnTracked: state.previewViewColumn,
        isMultiFilePreview: state.isMultiFilePreview,
        relocatingEditor: !!state._relocatingEditor,
        currentEditorFile: state.currentEditor ? state.currentEditor.document.uri.fsPath : null,
        layout: layoutInfo
      })

      // If a source editor became active in the SAME column as the preview, it is
      // covering the preview (e.g. the preview was focused and a file was opened from
      // the Explorer). Relocate that editor to the other column so the preview stays
      // visible. We compare against the TRACKED preview column because the panel's own
      // viewColumn is undefined while it is hidden behind the editor. VS Code doesn't
      // allow intercepting the Explorer open beforehand, so we react right after the
      // editor becomes active; the move re-fires this event with the editor in its new
      // column, which then runs the normal preview setup below.
      if (state.panel && !state.isMultiFilePreview && !state._relocatingEditor
        && ed.viewColumn && state.previewViewColumn && ed.viewColumn === state.previewViewColumn) {
        const p = ed.document.uri.fsPath
        const isSource = ed.document.languageId === 'markdown' || p.endsWith('.asn') || this.isCRJsonFile(p)
        logger.log('[RELOC] editor is in preview column', { isSource, languageId: ed.document.languageId })
        if (isSource) {
          state._relocatingEditor = true
          const moveCmd = state.previewViewColumn === vscode.ViewColumn.One
            ? 'workbench.action.moveEditorToRightGroup'
            : 'workbench.action.moveEditorToLeftGroup'
          logger.log('[RELOC] executing move command', { moveCmd, previewViewColumn: state.previewViewColumn })
          Promise.resolve(vscode.commands.executeCommand(moveCmd)).then(() => {
            logger.log('[RELOC] move command resolved', {
              newActiveEditorColumn: vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : null,
              panelVisibleAfter: state.panel ? state.panel.visible : null,
              panelViewColumnAfter: state.panel ? state.panel.viewColumn : null
            })
            setTimeout(() => { state._relocatingEditor = false }, 300)
          }, (err) => {
            logger.log('[RELOC] move command REJECTED', { error: String(err) })
            state._relocatingEditor = false
          })
          return
        }
      } else {
        logger.log('[RELOC] relocation condition NOT met', {
          panel: !!state.panel,
          notMultiFile: !state.isMultiFilePreview,
          notRelocating: !state._relocatingEditor,
          edHasColumn: !!ed.viewColumn,
          trackedColumn: state.previewViewColumn,
          columnsEqual: ed.viewColumn === state.previewViewColumn
        })
      }

      if (state.currentEditor && ed.document === state.currentEditor.document) {
        state.currentEditor = ed
        state.lastFocusedIsEditor = true
      } else if (state.panel && !state.isMultiFilePreview && !state._suppressPreviewRebuild) {
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
