const vscode = require('vscode')
const path = require('path')
const { Md2Html } = require('specpress/lib/md2html/md2html')
const { collectFiles, concatenateFiles } = require('specpress/lib/common/specProcessor')
const { getFileFromCommit, collectFilesFromCommit } = require('specpress/lib/common/gitHelpers')

/** Scroll synchronization and double-click navigation script injected into the webview preview. */
const scrollSyncScript = `<script>
const vscode = acquireVsCodeApi();
let isScrolling = false;
let scrollTimeout = null;

window.addEventListener('load', () => {
  vscode.postMessage({ type: 'webviewReady' });
});

window.addEventListener('scroll', () => {
  if (isScrolling) return;

  if (scrollTimeout) clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    const elements = document.querySelectorAll('[data-source-line]');
    let sourceLine = 0;

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.top >= 0) {
        sourceLine = parseInt(el.getAttribute('data-source-line'));
        break;
      }
    }

    vscode.postMessage({ type: 'scroll', sourceLine });
  }, 50);
});

window.addEventListener('focus', () => {
  vscode.postMessage({ type: 'focus' });
});

window.addEventListener('dblclick', (e) => {
  let el = e.target;
  while (el && !el.getAttribute('data-source-line')) {
    el = el.parentElement;
  }
  if (!el) return;
  const sourceLine = parseInt(el.getAttribute('data-source-line'));
  const sourceFile = el.getAttribute('data-source-file') || null;
  vscode.postMessage({ type: 'openFile', sourceLine, sourceFile });
});

window.addEventListener('contextmenu', (e) => {
  let el = e.target;
  while (el && !el.getAttribute('data-source-line')) {
    el = el.parentElement;
  }
  if (!el) return;
  vscode.postMessage({
    type: 'contextTarget',
    sourceLine: parseInt(el.getAttribute('data-source-line')),
    sourceFile: el.getAttribute('data-source-file') || null
  });
});

window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'scrollTo') {
    isScrolling = true;
    const targetElement = document.querySelector('[data-source-line="' + message.sourceLine + '"]');
    if (targetElement) {
      targetElement.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
    setTimeout(() => isScrolling = false, 150);
  } else if (message.type === 'scrollToFile') {
    const file = message.file;
    const line = message.line || 0;
    let best = null;
    let bestDist = Infinity;
    document.querySelectorAll('[data-source-file]').forEach(el => {
      if (el.getAttribute('data-source-file') === file) {
        const elLine = parseInt(el.getAttribute('data-source-line')) || 0;
        const dist = Math.abs(elLine - line);
        if (dist < bestDist) { bestDist = dist; best = el; }
      }
    });
    if (best) {
      best.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }
});
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
    this.state.handler = new Md2Html({
      css: this.config.loadCss(this.extensionDir),
      mermaidConfig: this.config.loadMermaidConfig(this.extensionDir),
      coverPageHtml: this.config.loadCoverPage(),
      customRenderers: this.config.customRenderers,
      resolveImageUri: (absPath) => this.state.panel ? this.state.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString() : absPath,
      extraHeadContent: scrollSyncScript
    })
  }

  /** Ensures the handler is initialized. */
  ensureHandler() {
    if (!this.state.handler) this.initHandler()
  }

  /**
   * Registers the webview message handler on the panel.
   * Handles scroll sync, double-click file opening, restore button, and scroll restore.
   */
  registerMessageHandler() {
    const state = this.state
    state.panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'webviewReady') {
        if (state.isMultiFilePreview && state.restoreScrollTarget) {
          state.panel.webview.postMessage({ type: 'scrollToFile', file: state.restoreScrollTarget.file, line: state.restoreScrollTarget.line })
          state.restoreScrollTarget = null
        }
      } else if (message.type === 'scroll' && state.currentEditor && !state.isMultiFilePreview && !state.isEditorScrolling && !state.lastFocusedIsEditor) {
        state.isPreviewScrolling = true
        const range = new vscode.Range(message.sourceLine, 0, message.sourceLine, 0)
        state.currentEditor.revealRange(range, vscode.TextEditorRevealType.AtTop)
        setTimeout(() => state.isPreviewScrolling = false, 150)
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
   * Sets up or updates the preview panel for a given editor.
   * @param {vscode.TextEditor} editor - The editor whose document to preview.
   */
  setupPreview(editor) {
    if (!editor) return
    const isMarkdown = editor.document.languageId === 'markdown'
    const isAsn = editor.document.fileName.endsWith('.asn')
    if (!isMarkdown && !isAsn) return
    if (!this.config.isInsideSpecRoot(editor.document.uri.fsPath)) return

    const state = this.state
    state.disposeListeners()
    state.currentEditor = editor
    state.isMultiFilePreview = false
    vscode.commands.executeCommand('setContext', 'specpress.isMultiFilePreview', false)

    const isNewPanel = !state.panel

    if (!state.panel) {
      const resourceRoot = this.config.findSpecRootFor(editor.document.uri.fsPath)
        || this.config.wsRoot
        || path.dirname(editor.document.uri.fsPath)
      state.panel = vscode.window.createWebviewPanel('specpressPreview', 'Markdown Preview',
        vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [vscode.Uri.file(resourceRoot)] })
      state.panel.onDidDispose(() => state.onPanelDisposed())
      this.registerMessageHandler()
    }

    this.ensureHandler()
    const isAsnFile = editor.document.fileName.endsWith('.asn')
    const content = isAsnFile
      ? '```asn\n' + editor.document.getText() + '\n```'
      : editor.document.getText()
    state.panel.webview.html = state.handler.renderMarkdown(content, path.dirname(editor.document.uri.fsPath), editor.document.uri.fsPath, this.config.getSpecRootForFile(editor.document.uri.fsPath))
    state.panel.title = `Preview: ${path.basename(editor.document.fileName)}`

    if (isNewPanel) {
      vscode.window.showTextDocument(editor.document, editor.viewColumn, false)
    }

    state.updatePreview = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === state.currentEditor.document && state.panel) {
        const text = state.currentEditor.document.fileName.endsWith('.asn')
          ? '```asn\n' + e.document.getText() + '\n```'
          : e.document.getText()
        state.panel.webview.html = state.handler.renderMarkdown(text, path.dirname(state.currentEditor.document.uri.fsPath), state.currentEditor.document.uri.fsPath, this.config.getSpecRootForFile(state.currentEditor.document.uri.fsPath))
      }
    })

    const jsonSaveListener = vscode.workspace.onDidSaveTextDocument(doc => {
      if (!state.panel || !state.currentEditor || state.isMultiFilePreview) return
      if (doc.fileName.endsWith('.json') && state.currentEditor.document.languageId === 'markdown') {
        const mdDir = path.dirname(state.currentEditor.document.uri.fsPath)
        if (doc.uri.fsPath.startsWith(mdDir)) {
          const text = state.currentEditor.document.getText()
          state.panel.webview.html = state.handler.renderMarkdown(text, mdDir, state.currentEditor.document.uri.fsPath, this.config.getSpecRootForFile(state.currentEditor.document.uri.fsPath))
        }
      }
    })

    state.scrollSync = vscode.window.onDidChangeTextEditorVisibleRanges(e => {
      if (state.panel && !state.isMultiFilePreview && !state.isPreviewScrolling && state.lastFocusedIsEditor
        && state.currentEditor && e.textEditor.document === state.currentEditor.document) {
        state.isEditorScrolling = true
        const firstVisibleLine = e.visibleRanges[0].start.line
        state.panel.webview.postMessage({ type: 'scrollTo', sourceLine: firstVisibleLine })
        setTimeout(() => state.isEditorScrolling = false, 150)
      }
    })

    const editorFocusListener = vscode.window.onDidChangeActiveTextEditor(ed => {
      if (ed && state.currentEditor && ed.document === state.currentEditor.document) {
        state.currentEditor = ed
        state.lastFocusedIsEditor = true
      }
    })

    state.panel.onDidDispose(() => {
      state.onPanelDisposed()
      editorFocusListener.dispose()
      jsonSaveListener.dispose()
    })
  }

  /**
   * Builds and displays a multi-file preview.
   *
   * @param {vscode.Uri[]} uris - Selected file/folder URIs.
   * @param {{ repoRoot: string, commit: string, shortHash: string }|null} commitRef - Git commit reference, or null for local files.
   */
  async previewMultiple(uris, commitRef) {
    const state = this.state
    const config = this.config

    state.disposeListeners()
    state.isMultiFilePreview = true
    vscode.commands.executeCommand('setContext', 'specpress.isMultiFilePreview', true)
    state.currentEditor = null
    state.lastMultiFileUris = uris
    state.isSpecRootPreview = config.isSpecRootSelection(uris)

    const buildPreview = () => {
      const files = commitRef
        ? collectFilesFromCommit(commitRef.repoRoot, uris.map(u => u.fsPath), commitRef.commit)
        : collectFiles(uris.map(u => u.fsPath))

      const filePaths = files.filter(f => f.endsWith('.md') || f.endsWith('.markdown'))

      this.ensureHandler()

      const specRoot = files.length > 0 ? config.getSpecRootForFile(files[0]) : ''
      const readFile = commitRef ? (f) => getFileFromCommit(commitRef.repoRoot, f, commitRef.commit) : undefined
      const processedContent = concatenateFiles(files, readFile, specRoot)

      state.multiFileContent = processedContent
      state.multiFilePaths = filePaths
      state.multiFileAllFiles = files
      state.multiFileBaseDir = files.length > 0 ? path.dirname(files[0]) : (config.wsRoot || '')

      const baseDir = config.wsRoot || state.multiFileBaseDir

      if (!state.panel) {
        const resourceRoot = (files.length > 0 ? config.findSpecRootFor(files[0]) : '')
          || config.wsRoot
          || baseDir
        state.panel = vscode.window.createWebviewPanel('specpressPreview', 'Multiple Files Preview',
          vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [vscode.Uri.file(resourceRoot)] })
        state.panel.onDidDispose(() => state.onPanelDisposed())
        this.registerMessageHandler()
      }

      state.panel.title = commitRef ? `Preview (${commitRef.shortHash})` : 'Multiple Files Preview'
      state.panel.webview.html = state.handler.renderMarkdown(processedContent, baseDir, null, specRoot, state.isSpecRootPreview)
    }

    const title = commitRef ? `Loading preview from ${commitRef.shortHash}...` : 'Loading preview...'
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      async () => buildPreview()
    )
  }
}

module.exports = { PreviewManager, scrollSyncScript }
