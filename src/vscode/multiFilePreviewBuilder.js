const vscode = require('vscode')
const path = require('path')
const { collectFiles, concatenateFiles, collectFilesFromCommit, createLocalResolver, createCommitResolver, getRepoRoot, diffHtml } = require('specpress')
const { insertOmittedMarkers } = require('./helpers')

/**
 * Builds and displays a multi-file preview.
 *
 * @param {Object} state
 * @param {Object} config
 * @param {Function} ensureHandler - `(specRoot) => void`
 * @param {Function} registerMessageHandler
 * @param {Function} buildResourceRoots - `() => vscode.Uri[]` — roots for current resolver only
 * @param {vscode.Uri[]} uris
 * @param {{ repoRoot: string, commit: string, shortHash: string }|null} commitRef - base version
 * @param {{ repoRoot: string, commit: string, shortHash: string }|'local'|null} baselineRef - compare version (null = no diff)
 */
async function previewMultiple(state, config, ensureHandler, registerMessageHandler, buildResourceRoots, uris, commitRef, baselineRef) {
  console.log('[SpecPress] previewMultiple called with', uris.length, 'URIs')

  state.disposeListeners()
  state.isMultiFilePreview = true
  vscode.commands.executeCommand('setContext', 'specpress.isMultiFilePreview', true)
  state.currentEditor = null
  state.lastMultiFileUris = uris
  state.lastMultiFileCommitRef = commitRef
  state.lastMultiFileBaselineRef = baselineRef
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

      // Always use findSpecRootFor (works regardless of deriveSectionNumbers setting)
      const specRoot = files.length > 0 ? config.findSpecRootFor(files[0]) : ''
      const sectionSpecRoot = files.length > 0 ? config.getSpecRootForFile(files[0]) : ''

      // Build resolver for the base (old) version
      let oldResolver
      if (commitRef && specRoot) {
        oldResolver = createCommitResolver(commitRef.repoRoot, specRoot, commitRef.commit)
      } else {
        let repoRoot = specRoot || config.wsRoot || ''
        try { repoRoot = getRepoRoot(repoRoot) } catch (e) { /* not a git repo */ }
        oldResolver = createLocalResolver(repoRoot, specRoot || repoRoot)
      }

      // Build resolver for the compare (new) version, if requested
      let compareResolver = null
      if (baselineRef === 'local') {
        let repoRoot = specRoot || config.wsRoot || ''
        try { repoRoot = getRepoRoot(repoRoot) } catch (e) { /* not a git repo */ }
        compareResolver = createLocalResolver(repoRoot, specRoot || repoRoot)
      } else if (baselineRef && specRoot) {
        compareResolver = createCommitResolver(baselineRef.repoRoot, specRoot, baselineRef.commit)
      }

      // state.currentResolver drives the handler — use compare resolver when diffing
      state.currentResolver = compareResolver || oldResolver

      if (state.panel) {
        state._replacingPanel = true
        state.panel.dispose()
        state._replacingPanel = false
        state.panel = null
      }

      // localResourceRoots: current (compare) resolver + old resolver (if diff)
      // buildResourceRoots() uses state.currentResolver which is now set correctly
      const resourceRoots = buildResourceRoots()
      if (compareResolver) resourceRoots.push(vscode.Uri.file(oldResolver.rootDir))

      state.panel = vscode.window.createWebviewPanel('specpressPreview', 'Multiple Files Preview',
        vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: resourceRoots })
      state.panel.onDidDispose(() => state.onPanelDisposed())
      registerMessageHandler()

      // Set resolveImageUri on resolvers now that the panel exists
      // Must be done BEFORE ensureHandler so initHandler sees them already set
      const makeResolveUri = (r) => (absPath) =>
        state.panel.webview.asWebviewUri(vscode.Uri.file(r.getAbsPath(absPath))).toString()
      oldResolver.resolveImageUri = makeResolveUri(oldResolver)
      if (compareResolver) compareResolver.resolveImageUri = makeResolveUri(compareResolver)
      state.handler = null
      ensureHandler(sectionSpecRoot)

      // Load cover page data if at spec root — prompt user to select
      let frontPageData = null
      let crCoverPageData = null
      if (state.isSpecRootPreview) {
        const { selectCoverPage } = require('./coverPageSelector')
        const coverPageChoice = await selectCoverPage(config, specRoot)
        if (!coverPageChoice) return  // user cancelled
        frontPageData = coverPageChoice.type === 'standard' ? coverPageChoice.frontPage : null
        crCoverPageData = coverPageChoice.type === 'cr' ? coverPageChoice.crData : null
      }

      const readFile = commitRef
        ? (f) => oldResolver.readFile(f, 'utf8')
        : undefined
      let processedContent = concatenateFiles(files, readFile, sectionSpecRoot)
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

      // Build title
      const baseLabel = commitRef ? commitRef.shortHash : 'local'
      const baselineLabel = baselineRef === 'local' ? 'local' : baselineRef ? baselineRef.shortHash : null
      state.panel.title = baselineLabel
        ? `Preview (${baseLabel} vs ${baselineLabel})`
        : commitRef ? `Preview (${baseLabel})` : 'Multiple Files Preview'

      // commitRef = old/base version (processedContent), baselineRef = new/compare version
      // For diff: baseline (old) = commitRef content, current (new) = baselineRef content
      let html

      if (compareResolver) {
        // Read the new (compare) version content
        // Collect files independently so renamed/added files are included
        const compareFiles = baselineRef === 'local'
          ? collectFiles(uris.map(u => u.fsPath))
          : collectFilesFromCommit(baselineRef.repoRoot, uris.map(u => u.fsPath), baselineRef.commit)
        const compareContent = concatenateFiles(
          compareFiles,
          (f) => compareResolver.readFile(f, 'utf8'),
          sectionSpecRoot
        )

        // Resolve compare-version front page data
        let compareFrontPageData = frontPageData
        if (frontPageData && !crCoverPageData) {
          const dataFile = config.frontPageData
          if (dataFile) {
            const compareJson = compareResolver.readFileOrNull(dataFile, 'utf8')
            if (compareJson) {
              try { compareFrontPageData = JSON.parse(compareJson) } catch (e) { /* use current */ }
            }
          }
        }

        // Render the compare version as the HTML shell (for <head>, scripts, etc.)
        // diffHtml re-renders both versions internally with stable relative paths
        html = state.handler.renderMarkdown(compareContent, baseDir, null, sectionSpecRoot, compareFrontPageData, crCoverPageData)
        const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/)
        if (bodyMatch) {
          const diffBody = diffHtml({
            baselineContent: processedContent,
            currentContent: compareContent,
            handler: state.handler,
            baselineFileResolver: oldResolver,
            frontPageData,
            crCoverPageData,
          })
          html = html.replace(bodyMatch[0], '<body>' + diffBody + '</body>')
        }
      } else {
        html = state.handler.renderMarkdown(processedContent, baseDir, null, sectionSpecRoot, frontPageData, crCoverPageData)
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

  // Re-render multi-file preview when spec files are saved (local base, no diff)
  if (!commitRef && !baselineRef) {
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
