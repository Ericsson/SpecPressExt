const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const { buildFrontPageHtml } = require('specpress/lib/md2html/frontPage')
const { collectFiles, concatenateFiles } = require('specpress/lib/common/specProcessor')
const { getFileFromCommit, collectFilesFromCommit } = require('specpress/lib/common/gitHelpers')
const { insertOmittedMarkers } = require('./helpers')
const { loadCRCoverPage } = require('./crCoverPageHelper')
const { applyDiff } = require('./diffRenderer')
const { selectCoverPage } = require('./coverPageSelector')

/**
 * Builds and displays a multi-file preview.
 *
 * @param {Object} state - StateManager instance.
 * @param {Object} config - ConfigLoader instance.
 * @param {Function} ensureHandler - Function to ensure handler is initialized.
 * @param {Function} registerMessageHandler - Function to register webview message handler.
 * @param {vscode.Uri[]} uris - Selected file/folder URIs.
 * @param {{ repoRoot: string, commit: string, shortHash: string }|null} commitRef - Git commit reference, or null for local files.
 */
async function previewMultiple(state, config, ensureHandler, registerMessageHandler, uris, commitRef) {
  console.log('[SpecPress] previewMultiple called with', uris.length, 'URIs')

  state.disposeListeners()
  state.isMultiFilePreview = true
  vscode.commands.executeCommand('setContext', 'specpress.isMultiFilePreview', true)
  state.currentEditor = null
  state.lastMultiFileUris = uris
  state.isSpecRootPreview = config.isSpecRootSelection(uris)
  state.contextStartIdx = -1
  state.contextEndIdx = -1
  state.contextFiles = []
  state.currentFileIndex = -1
  state.adjacentFileCache.clear()

  const buildPreview = async () => {
    try {
      const files = commitRef
        ? collectFilesFromCommit(commitRef.repoRoot, uris.map(u => u.fsPath), commitRef.commit)
        : collectFiles(uris.map(u => u.fsPath))

      const filePaths = files.filter(f => f.endsWith('.md') || f.endsWith('.markdown'))

      // Build image cache from git commit if viewing a commit
      let imageCache = null
      if (commitRef) {
        const { extractFilesFromCommit } = require('./helpers')
        const specRoots = files.length > 0 ? [config.getSpecRootForFile(files[0])] : []
        imageCache = extractFilesFromCommit(commitRef.repoRoot, commitRef.commit, specRoots)
      }

      ensureHandler()

      // Override image resolver for git commits
      if (commitRef && imageCache) {
        const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()
        state.handler.resolveImageUri = (absPath) => {
          let imgData = imageCache.get(absPath)
          if (!imgData) {
            const target = normPath(absPath)
            for (const [key, val] of imageCache) {
              if (normPath(key) === target) { imgData = val; break }
            }
          }
          if (imgData && Buffer.isBuffer(imgData)) {
            const ext = absPath.split('.').pop().toLowerCase()
            const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
            return `data:${mime};base64,${imgData.toString('base64')}`
          }
          return state.panel ? state.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString() : absPath
        }
      } else {
        state.handler.resolveImageUri = (absPath) => state.panel ? state.panel.webview.asWebviewUri(vscode.Uri.file(absPath)).toString() : absPath
      }

      const specRoot = files.length > 0 ? config.getSpecRootForFile(files[0]) : ''

      // Select cover page if at spec root
      let frontPageHtml = null
      let crCoverPageData = null

      if (state.isSpecRootPreview) {
        const coverPageChoice = await selectCoverPage(config, specRoot)
        if (!coverPageChoice) return // User cancelled

        if (coverPageChoice.type === 'cr') {
          crCoverPageData = coverPageChoice.crData
        } else if (coverPageChoice.type === 'standard') {
          frontPageHtml = buildFrontPageHtml(config.loadFrontPageData())
        }
        // else: type === 'none', both remain null
      }

      // Set front page HTML
      state.handler.frontPageHtml = frontPageHtml

      const readFile = commitRef ? (f) => getFileFromCommit(commitRef.repoRoot, f, commitRef.commit) : undefined
      let processedContent = concatenateFiles(files, readFile, specRoot)
      if (specRoot && !state.isSpecRootPreview) {
        const allFiles = collectFiles([specRoot])
        if (files.length < allFiles.length) {
          processedContent = insertOmittedMarkers(processedContent, files, allFiles)
        }
      }

      state.multiFileContent = processedContent
      state.multiFilePaths = filePaths
      state.multiFileAllFiles = files
      state.multiFileBaseDir = files.length > 0 ? path.dirname(files[0]) : (config.wsRoot || '')

      const baseDir = config.wsRoot || state.multiFileBaseDir

      if (!state.panel) {
        const resourceRoot = (files.length > 0 ? config.findSpecRootFor(files[0]) : '')
          || config.wsRoot
          || baseDir
        const cachedDir = path.join(path.dirname(resourceRoot), 'cached')
        const resourceRoots = [vscode.Uri.file(resourceRoot)]
        if (fs.existsSync(cachedDir)) resourceRoots.push(vscode.Uri.file(cachedDir))
        state.panel = vscode.window.createWebviewPanel('specpressPreview', 'Multiple Files Preview',
          vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: resourceRoots })
        state.panel.onDidDispose(() => state.onPanelDisposed())
        registerMessageHandler()
      }

      state.panel.title = commitRef ? `Preview (${commitRef.shortHash})` : (state.changeTrackingCommit ? 'Preview (changes)' : 'Multiple Files Preview')
      const frontPageData = state.isSpecRootPreview ? config.loadFrontPageData() : null
      let html = state.handler.renderMarkdown(processedContent, baseDir, null, specRoot, frontPageData, crCoverPageData)
      if (!commitRef) {
        html = applyDiff(state, state.handler, config, html, processedContent, null, files, { baseDir, specRoot, frontPageData, crCoverPageData })
      }
      state.panel.webview.html = html
    } catch (error) {
      vscode.window.showErrorMessage(`SpecPress preview failed: ${error.message}`)
      console.error('SpecPress preview error:', error)
      throw error
    }
  }

  const title = commitRef ? `Loading preview from ${commitRef.shortHash}...` : 'Loading preview...'
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      async () => buildPreview()
    )
  } catch (error) {
    vscode.window.showErrorMessage(`SpecPress: Failed to build preview - ${error.message}`)
    console.error('Preview error:', error)
  }

  // Re-render multi-file preview when spec files are saved
  if (!commitRef) {
    state.fileSaveListener = vscode.workspace.onDidSaveTextDocument(doc => {
      if (!state.panel || !state.isMultiFilePreview) return
      const ext = path.extname(doc.fileName).toLowerCase()
      if (!['.md', '.markdown', '.asn', '.json'].includes(ext)) return
      if (!config.isInsideSpecRoot(doc.uri.fsPath)) return
      buildPreview()
    })
  }
}

module.exports = { previewMultiple }
