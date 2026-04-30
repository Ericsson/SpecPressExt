const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const HtmlDiff = require('htmldiff-js')
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
   * Applies change tracking by diffing rendered HTML of baseline vs current.
   * Uses htmldiff-js for word-level HTML diffing that preserves all formatting.
   *
   * @param {string} currentHtml - Full rendered HTML of the current version.
   * @param {string} content - Current markdown content (for baseline rendering).
   * @param {string} filePath - Source file path (for single-file mode).
   * @param {string[]} [files] - All files (for multi-file mode).
   * @param {Object} renderOpts - { baseDir, specRoot, filePath, includeCoverPage } for rendering baseline.
   * @returns {string} HTML with tracked changes, or original HTML if tracking disabled.
   */
  applyDiff(currentHtml, content, filePath, files, renderOpts) {
    const state = this.state
    if (!state.changeTrackingCommit || !state.changeTrackingBaseline) return currentHtml

    const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()

    // Get baseline content
    let baselineContent = ''
    if (filePath) {
      baselineContent = state.changeTrackingBaseline.get(filePath) || ''
      if (!baselineContent) {
        const target = normPath(filePath)
        for (const [key, val] of state.changeTrackingBaseline) {
          if (normPath(key) === target) { baselineContent = val; break }
        }
      }
    } else if (files) {
      const specRoot = renderOpts.specRoot || ''
      const getBaseline = (f) => {
        if (state.changeTrackingBaseline.has(f)) return state.changeTrackingBaseline.get(f)
        const target = normPath(f)
        for (const [key, val] of state.changeTrackingBaseline) {
          if (normPath(key) === target) return val
        }
        return ''
      }
      const baselineFiles = files.filter(f => getBaseline(f) !== '')
      baselineContent = concatenateFiles(baselineFiles, getBaseline, specRoot)
    }

    if (!baselineContent) return currentHtml

    // Normalize line endings
    baselineContent = baselineContent.replace(/\r\n/g, '\n')

    // Inline linked JsonTable files from baseline cache so they render correctly
    baselineContent = baselineContent.replace(/\[JsonTable\]\(([^)]+\.json)\)/g, (match, jsonRelPath) => {
      try {
        const beforeMatch = baselineContent.substring(0, baselineContent.indexOf(match))
        const fileComment = beforeMatch.match(/<!-- FILE: (.+?) -->/g)
        const lastFile = fileComment ? fileComment[fileComment.length - 1].match(/<!-- FILE: (.+?) -->/)[1] : (filePath || (files && files[0]) || '')
        const dir = path.dirname(lastFile)
        const jsonPath = path.isAbsolute(jsonRelPath) ? jsonRelPath : path.join(dir, jsonRelPath)

        let baselineJson = state.changeTrackingBaseline.get(jsonPath) || null
        if (!baselineJson) {
          const target = normPath(jsonPath)
          for (const [key, val] of state.changeTrackingBaseline) {
            if (normPath(key) === target) { baselineJson = val; break }
          }
        }
        if (baselineJson) {
          return '```jsonTable\n' + baselineJson + '\n```'
        }
      } catch (e) { /* fall through */ }
      return match
    })

    // Render baseline to HTML body
    this.ensureHandler()
    const includeCover = !!renderOpts.includeCoverPage
    let savedCoverHtml = null
    if (includeCover) {
      savedCoverHtml = state.handler.coverPageHtml
      const baselineCover = this._buildBaselineCoverPage(state, normPath)
      state.handler.coverPageHtml = baselineCover !== null ? baselineCover : savedCoverHtml
    }
    const baselineBody = state.handler.renderBody(
      baselineContent, false,
      renderOpts.baseDir || null,
      renderOpts.filePath || null,
      renderOpts.specRoot || null,
      includeCover
    )
    if (savedCoverHtml !== null) state.handler.coverPageHtml = savedCoverHtml

    // Extract body from current HTML
    const bodyMatch = currentHtml.match(/<body>([\s\S]*)<\/body>/)
    if (!bodyMatch) return currentHtml
    const currentBody = bodyMatch[1]

    // Pre-process: replace images and mermaid blocks with stable placeholders
    const placeholders = new Map()
    const hashContent = (data) => crypto.createHash('md5').update(data).digest('hex').substring(0, 12)

    const replaceBlocks = (html, version) => {
      // Replace mermaid pre blocks
      html = html.replace(/<pre class="mermaid"[^>]*>[\s\S]*?<\/pre>/g, (match) => {
        const hash = hashContent(match)
        const id = `MERMAID_${hash}`
        if (!placeholders.has(id)) placeholders.set(id, {})
        placeholders.get(id)[version] = match
        return ` ${id} `
      })
      // Replace img tags
      html = html.replace(/<img[^>]*>/g, (match) => {
        const src = (match.match(/src="([^"]+)"/) || [])[1] || ''
        const decodedSrc = decodeURIComponent(src)
        const filename = decodedSrc.split('/').pop().split('?')[0]
        const id = `IMG_${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`
        if (!placeholders.has(id)) placeholders.set(id, { filename })
        const entry = placeholders.get(id)
        entry[version] = match
        if (version === 'current') {
          try {
            let imgPath = ''
            if (path.isAbsolute(decodedSrc)) {
              imgPath = decodedSrc
            } else {
              imgPath = path.join(renderOpts.baseDir || '', decodedSrc)
            }
            if (imgPath && fs.existsSync(imgPath)) {
              entry.currentHash = hashContent(fs.readFileSync(imgPath))
            }
          } catch (e) { /* no hash */ }
        } else {
          for (const [key, val] of state.changeTrackingBaseline) {
            if (normPath(key).endsWith('/' + normPath(filename))) {
              entry.baselineHash = hashContent(Buffer.isBuffer(val) ? val : Buffer.from(val))
              break
            }
          }
        }
        return ` ${id} `
      })
      return html
    }

    const processedBaseline = replaceBlocks(baselineBody, 'baseline')
    const processedCurrent = replaceBlocks(currentBody, 'current')

    let diffedBody = HtmlDiff.default.execute(processedBaseline, processedCurrent)

    // Restore placeholders
    for (const [id, entry] of placeholders) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

      // Placeholder wrapped in <del> (removed)
      const delRe = new RegExp(`<del[^>]*>[^<]*?${escaped}[^<]*?<\\/del>`, 'g')
      diffedBody = diffedBody.replace(delRe, () => {
        const html = entry.baseline || entry.current || ''
        const label = id.startsWith('MERMAID_') ? 'Deleted figure:' : 'Deleted image:'
        return `<div class="diff-del-block"><p class="diff-label">${label}</p>${html}</div>`
      })

      // Placeholder wrapped in <ins> (added)
      const insRe = new RegExp(`<ins[^>]*>[^<]*?${escaped}[^<]*?<\\/ins>`, 'g')
      diffedBody = diffedBody.replace(insRe, () => {
        const html = entry.current || entry.baseline || ''
        const label = id.startsWith('MERMAID_') ? 'New figure:' : 'New image:'
        return `<div class="diff-ins-block"><p class="diff-label">${label}</p>${html}</div>`
      })

      // Placeholder text unchanged — restore or show diff if content changed
      const plainRe = new RegExp(` ${escaped} `, 'g')
      diffedBody = diffedBody.replace(plainRe, () => {
        if (id.startsWith('IMG_') && entry.baselineHash && entry.currentHash && entry.baselineHash !== entry.currentHash) {
          const currentImg = entry.current || ''
          let oldImg = ''
          const targetName = normPath(entry.filename || '')
          for (const [key, val] of state.changeTrackingBaseline) {
            if (Buffer.isBuffer(val) && normPath(key).endsWith('/' + targetName)) {
              const ext = key.split('.').pop().toLowerCase()
              const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
              const b64 = val.toString('base64')
              const alt = (currentImg.match(/alt="([^"]*)"/) || [])[1] || ''
              oldImg = `<img src="data:${mime};base64,${b64}" alt="${alt}">`
              break
            }
          }
          if (!oldImg) oldImg = currentImg
          return `<div class="diff-del-block"><p class="diff-label">Old image:</p>${oldImg}</div><div class="diff-ins-block"><p class="diff-label">New image:</p>${currentImg}</div>`
        }
        if (id.startsWith('MERMAID_') && entry.baseline && entry.current && entry.baseline !== entry.current) {
          return `<div class="diff-del-block"><p class="diff-label">Deleted figure:</p>${entry.baseline}</div><div class="diff-ins-block"><p class="diff-label">New figure:</p>${entry.current}</div>`
        }
        return entry.current || entry.baseline || ` ${id} `
      })
    }

    return currentHtml.replace(bodyMatch[0], '<body>' + diffedBody + '</body>')
  }

  /**
   * Builds cover page HTML from the baseline cache's cover_data.json.
   * @returns {string|null} Rendered cover page HTML, or null if not available.
   */
  _buildBaselineCoverPage(state, normPath) {
    const dataFile = this.config.coverPageData
    if (!dataFile) return null

    const targetName = normPath(path.basename(dataFile))
    let baselineDataJson = null
    for (const [key, val] of state.changeTrackingBaseline) {
      if (typeof val === 'string' && normPath(key).endsWith('/' + targetName)) {
        baselineDataJson = val
        break
      }
    }
    if (!baselineDataJson) return null

    try {
      const data = JSON.parse(baselineDataJson)
      if (!data.YEAR && data.DATE) data.YEAR = data.DATE.split('-')[0] || ''

      const templateFile = this.config.coverPageTemplate
      if (!templateFile) return null
      const wsRoot = this.config.wsRoot
      const templatePath = path.isAbsolute(templateFile) ? templateFile : path.join(wsRoot, templateFile)
      if (!fs.existsSync(templatePath)) return null

      let template = fs.readFileSync(templatePath, 'utf8')
      const bodyMatch = template.match(/<body[^>]*>([\s\S]*)<\/body>/i)
      if (bodyMatch) {
        const styles = []
        const styleRe = /<style[^>]*>[\s\S]*?<\/style>/gi
        let m
        while ((m = styleRe.exec(template)) !== null) styles.push(m[0])
        template = (styles.length ? styles.join('\n') + '\n' : '') + bodyMatch[1]
      }

      let result = template.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] !== undefined ? data[key] : match)

      const templateDir = path.dirname(templatePath)
      result = result.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/g, (match, before, src, after) => {
        if (src.startsWith('http') || src.startsWith('data:') || path.isAbsolute(src)) return match
        const absPath = path.join(templateDir, src)
        if (fs.existsSync(absPath)) return `<img${before}src="${absPath.replace(/\\/g, '/')}"${after}>`
        return match
      })

      return result
    } catch (e) {
      return null
    }
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
    const filePath = editor.document.uri.fsPath
    const specRoot = this.config.getSpecRootForFile(filePath)
    const baseDir = path.dirname(filePath)
    let html = state.handler.renderMarkdown(content, baseDir, filePath, specRoot)
    html = this.applyDiff(html, content, filePath, null, { baseDir, specRoot, filePath })
    state.panel.webview.html = html
    state.panel.title = state.changeTrackingCommit ? `Preview (changes): ${path.basename(editor.document.fileName)}` : `Preview: ${path.basename(editor.document.fileName)}`

    if (isNewPanel) {
      vscode.window.showTextDocument(editor.document, editor.viewColumn, false)
    }

    state.updatePreview = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === state.currentEditor.document && state.panel) {
        const text = state.currentEditor.document.fileName.endsWith('.asn')
          ? '```asn\n' + e.document.getText() + '\n```'
          : e.document.getText()
        const fp = state.currentEditor.document.uri.fsPath
        const sr = this.config.getSpecRootForFile(fp)
        const bd = path.dirname(fp)
        let h = state.handler.renderMarkdown(text, bd, fp, sr)
        h = this.applyDiff(h, text, fp, null, { baseDir: bd, specRoot: sr, filePath: fp })
        state.panel.webview.html = h
      }
    })

    state.fileSaveListener = vscode.workspace.onDidSaveTextDocument(doc => {
      if (!state.panel || state.isMultiFilePreview) return
      if (!state.currentEditor) return
      if (doc.fileName.endsWith('.json') && state.currentEditor.document.languageId === 'markdown') {
        const mdDir = path.dirname(state.currentEditor.document.uri.fsPath)
        if (doc.uri.fsPath.startsWith(mdDir)) {
          const text = state.currentEditor.document.getText()
          const fp = state.currentEditor.document.uri.fsPath
          const sr = this.config.getSpecRootForFile(fp)
          let h = state.handler.renderMarkdown(text, mdDir, fp, sr)
          h = this.applyDiff(h, text, fp, null, { baseDir: mdDir, specRoot: sr, filePath: fp })
          state.panel.webview.html = h
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
      if (state.isSpecRootPreview) state.handler.coverPageHtml = this.config.loadCoverPage()

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

      state.panel.title = commitRef ? `Preview (${commitRef.shortHash})` : (state.changeTrackingCommit ? 'Preview (changes)' : 'Multiple Files Preview')
      let html = state.handler.renderMarkdown(processedContent, baseDir, null, specRoot, state.isSpecRootPreview)
      html = this.applyDiff(html, processedContent, null, files, { baseDir, specRoot, includeCoverPage: state.isSpecRootPreview })
      state.panel.webview.html = html
    }

    const title = commitRef ? `Loading preview from ${commitRef.shortHash}...` : 'Loading preview...'
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      async () => buildPreview()
    )

    // Re-render multi-file preview when JSON files are saved
    if (!commitRef) {
      state.fileSaveListener = vscode.workspace.onDidSaveTextDocument(doc => {
        if (!state.panel || !state.isMultiFilePreview) return
        if (doc.fileName.endsWith('.json')) {
          this.ensureHandler()
          state.handler.coverPageHtml = this.config.loadCoverPage()
          const specRoot = state.multiFileAllFiles && state.multiFileAllFiles.length > 0
            ? this.config.getSpecRootForFile(state.multiFileAllFiles[0]) : ''
          const baseDir = this.config.wsRoot || state.multiFileBaseDir
          const content = state.multiFileContent
          if (!content) return
          let html = state.handler.renderMarkdown(content, baseDir, null, specRoot, state.isSpecRootPreview)
          html = this.applyDiff(html, content, null, state.multiFileAllFiles, { baseDir, specRoot, includeCoverPage: state.isSpecRootPreview })
          state.panel.webview.html = html
        }
      })
    }
  }
}

module.exports = { PreviewManager, scrollSyncScript }
