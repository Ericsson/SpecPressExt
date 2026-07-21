const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { getRepoRoot } = require('specpress/lib/common/gitHelpers')
const { createCommitResolver } = require('specpress/lib/common/fileResolver')
const { collectFiles, concatenateFiles, formatExportMessage } = require('specpress/lib/common/specProcessor')
const { Md2Html } = require('specpress/lib/md2html/md2html')
const { diffHtml } = require('specpress/lib/md2html/htmlDiff')
const { pickVersions, collectFilesFromUris, collectFilesFromCommitUris, insertOmittedMarkers, formatExportTimestamp, showExportNotification } = require('./helpers')
const { selectCoverPage } = require('./coverPageSelector')

/**
 * Handles the "Export Selected to HTML" command from the explorer context menu.
 * Supports exporting a single version or a diff between two versions.
 *
 * @param {import('./stateManager').StateManager} state
 * @param {import('./configLoader').ConfigLoader} config
 * @param {string} extensionDir - Absolute path to the extension root directory.
 * @param {vscode.Uri} [uri]
 * @param {vscode.Uri[]} [allUris]
 */
async function exportHtml(state, config, extensionDir, uri, allUris) {
  const uris = allUris || (uri ? [uri] : await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: true,
    filters: { 'Markdown': ['md', 'markdown', 'asn'] }
  }))
  if (!uris) return

  let repoRoot
  try {
    const firstPath = uris[0].fsPath
    repoRoot = getRepoRoot(fs.statSync(firstPath).isDirectory() ? firstPath : path.dirname(firstPath))
  } catch (e) {
    repoRoot = null
  }

  // Pick base version and optional compare version
  let commitRef = null
  let baselineRef = null
  if (repoRoot) {
    const versions = await pickVersions(
      repoRoot,
      'Select version for HTML export',
      'Compare against (select to export as HTML diff, or choose None to skip)'
    )
    if (versions === null) return
    const base = versions[0]
    commitRef = base.shortHash ? { repoRoot, commit: base.commitInput, shortHash: base.shortHash } : null
    const compare = versions.length > 1 ? versions[1] : null
    if (compare) {
      baselineRef = compare.shortHash
        ? { repoRoot, commit: compare.commitInput, shortHash: compare.shortHash }
        : 'local'
    }
  }

  const shortHash = commitRef ? commitRef.shortHash : null
  const commitInput = commitRef ? commitRef.commit : null
  const isDiff = baselineRef !== null
  const compareCommit = baselineRef === 'local' ? '' : (baselineRef ? baselineRef.commit : null)
  const compareShortHash = baselineRef === 'local' ? 'local' : (baselineRef ? baselineRef.shortHash : null)

  const specRoot = config.findSpecRootFor(uris[0].fsPath)
  const sectionSpecRoot = config.getSpecRootForFile(uris[0].fsPath)

  // Step 3: cover page selection (before save dialog)
  const coverPageChoice = await selectCoverPage(config, specRoot)
  if (!coverPageChoice) return

  const frontPageData = coverPageChoice.type === 'standard' ? coverPageChoice.frontPage : null
  const crCoverPageData = coverPageChoice.type === 'cr' ? coverPageChoice.crData : null

  // Step 4: save dialog
  const files = shortHash
    ? collectFilesFromCommitUris(repoRoot, uris, commitInput)
    : collectFilesFromUris(uris)
  if (files.length === 0) {
    vscode.window.showErrorMessage(shortHash ? `No markdown or ASN.1 files found in ${commitInput}` : 'No markdown or ASN.1 files found in selection')
    return
  }

  const ts = formatExportTimestamp()
  let defaultName
  if (isDiff) {
    const baseLabel = shortHash || 'local'
    const compareLabel = compareShortHash || 'local'
    defaultName = `${ts} DIFF_${baseLabel}_vs_${compareLabel}.html`
  } else {
    defaultName = shortHash ? `${ts} Export_${shortHash}.html` : `${ts} Export.html`
  }

  const saveUri = await vscode.window.showSaveDialog({
    filters: { 'HTML': ['html'] },
    defaultUri: vscode.Uri.file(path.join(config.getExportFolder(state.lastExportFolder), defaultName))
  })
  if (!saveUri) return
  state.lastExportFolder = path.dirname(saveUri.fsPath)

  try {
    let imageCount = 0
    const label = shortHash ? `${commitInput} (${shortHash})` : 'local files'
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting HTML from ${label}...`, cancellable: false },
      async () => {
        let baseResolver = null
        if (shortHash && specRoot) {
          baseResolver = createCommitResolver(repoRoot, specRoot, commitInput)
        }

        const readFile = baseResolver ? (f) => baseResolver.readFile(f, 'utf8') : undefined
        let content = concatenateFiles(files, readFile, sectionSpecRoot)
        if (specRoot && !config.isSpecRootSelection(uris)) {
          const allSpecFiles = collectFiles([specRoot])
          if (files.length < allSpecFiles.length) {
            content = insertOmittedMarkers(content, files, allSpecFiles)
          }
        }

        const handler = new Md2Html({
          css: config.loadCss(extensionDir),
          mermaidConfig: config.loadMermaidConfig(),
          specRootPath: sectionSpecRoot
        })

        const exportDir = path.dirname(saveUri.fsPath)
        const mediaDir = path.join(exportDir, 'media')
        fs.mkdirSync(mediaDir, { recursive: true })

        let html
        if (isDiff) {
          // Build compare resolver
          let compareResolver = null
          if (compareCommit && specRoot) {
            compareResolver = createCommitResolver(repoRoot, specRoot, compareCommit)
          }

          const compareFiles = compareCommit
            ? collectFilesFromCommitUris(repoRoot, uris, compareCommit)
            : collectFilesFromUris(uris)
          const compareReadFile = compareResolver ? (f) => compareResolver.readFile(f, 'utf8') : undefined
          const compareContent = concatenateFiles(compareFiles, compareReadFile, sectionSpecRoot)

          // Render the compare version as the HTML shell
          html = handler.renderMarkdownForExport(compareContent, sectionSpecRoot, frontPageData, crCoverPageData)
          const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/)
          if (bodyMatch) {
            const diffBody = diffHtml({
              baselineContent: content,
              currentContent: compareContent,
              handler,
              baselineFileResolver: baseResolver,
              frontPageData,
              crCoverPageData,
            })
            html = html.replace(bodyMatch[0], '<body>' + diffBody + '</body>')
          }
        } else {
          html = handler.renderMarkdownForExport(content, sectionSpecRoot, frontPageData, crCoverPageData)
        }

        html = html.replace(/\s*data-source-line="\d+"/g, '')
        html = html.replace(/\s*data-source-file="[^"]*"/g, '')

        const copiedImages = new Map()
        html = html.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/g, (match, before, src, after) => {
          if (/^(https?:|data:)/.test(src)) return match

          let imagePath = null
          if (path.isAbsolute(src)) {
            const exists = baseResolver ? baseResolver.exists(src) : fs.existsSync(src)
            if (exists) imagePath = src
          } else {
            if (specRoot) {
              const c = path.join(path.dirname(specRoot), src)
              if (baseResolver ? baseResolver.exists(c) : fs.existsSync(c)) imagePath = c
            }
            if (!imagePath) {
              for (const f of files) {
                const c = path.join(path.dirname(f), src)
                if (baseResolver ? baseResolver.exists(c) : fs.existsSync(c)) { imagePath = c; break }
              }
            }
          }
          if (!imagePath) return match

          if (copiedImages.has(imagePath)) {
            return `<img${before}src="media/${copiedImages.get(imagePath)}"${after}>`
          }

          const ext = path.extname(imagePath)
          const rel = specRoot ? path.relative(path.dirname(specRoot), imagePath) : path.basename(imagePath)
          const safeName = rel.slice(0, -ext.length).replace(/[\\/.]+/g, '_').replace(/^_+/, '') + ext
          try {
            const data = baseResolver ? baseResolver.readFile(imagePath) : fs.readFileSync(imagePath)
            fs.writeFileSync(path.join(mediaDir, safeName), data)
            copiedImages.set(imagePath, safeName)
            return `<img${before}src="media/${safeName}"${after}>`
          } catch (e) {
            return match
          }
        })

        fs.writeFileSync(saveUri.fsPath, html)
        imageCount = copiedImages.size
      }
    )

    const exportLabel = isDiff
      ? `HTML diff (${shortHash || 'local'} vs ${compareShortHash || 'local'})`
      : `HTML`
    showExportNotification(
      formatExportMessage(exportLabel, files.length, imageCount, shortHash ? `hash: ${shortHash}` : undefined),
      path.dirname(saveUri.fsPath)
    )
  } catch (e) {
    vscode.window.showErrorMessage(`HTML export failed: ${e.message}`)
  }
}

module.exports = { exportHtml }
