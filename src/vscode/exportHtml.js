const vscode = require('vscode')
const path = require('path')
const { getRepoRoot } = require('specpress/lib/common/gitHelpers')
const { exportHtml: exportHtmlCore } = require('specpress/lib/md2html/exportHtml')
const { collectFiles, collectFilesFromCommit, formatExportMessage } = require('specpress/lib/common/specProcessor')
const { pickVersions, collectFilesFromUris, collectFilesFromCommitUris, formatExportTimestamp, showExportNotification, warnIfMscgenMissing } = require('./helpers')
const { selectCoverPage } = require('./coverPageSelector')

/**
 * Handles the "Export Selected to HTML" command from the explorer context menu.
 * Supports exporting a single version or a diff between two versions.
 * All file I/O and rendering is delegated to specpress exportHtml().
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
    repoRoot = getRepoRoot(require('fs').statSync(firstPath).isDirectory() ? firstPath : path.dirname(firstPath))
  } catch (e) {
    repoRoot = null
  }

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
  const compareCommit = baselineRef === 'local' ? 'local' : (baselineRef ? baselineRef.commit : null)
  const compareShortHash = baselineRef === 'local' ? 'local' : (baselineRef ? baselineRef.shortHash : null)

  const specRoot = config.findSpecRootFor(uris[0].fsPath)
  const sectionSpecRoot = config.getSpecRootForFile(uris[0].fsPath)

  const coverPageChoice = await selectCoverPage(config, specRoot)
  if (!coverPageChoice) return

  const frontPageData = coverPageChoice.type === 'standard' ? coverPageChoice.frontPage : null
  const crCoverPageData = coverPageChoice.type === 'cr' ? coverPageChoice.crData : null

  const inputPaths = uris.map(u => u.fsPath)
  const files = shortHash
    ? collectFilesFromCommitUris(repoRoot, uris, commitInput)
    : collectFilesFromUris(uris)
  if (files.length === 0) {
    vscode.window.showErrorMessage(shortHash
      ? `No markdown or ASN.1 files found in ${commitInput}`
      : 'No markdown or ASN.1 files found in selection')
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

  warnIfMscgenMissing()

  try {
    let result
    const label = shortHash ? `${commitInput} (${shortHash})` : 'local files'
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting HTML from ${label}...`, cancellable: false },
      async () => {
        result = exportHtmlCore({
          inputPaths,
          outputPath: saveUri.fsPath,
          specRoot: sectionSpecRoot || specRoot,
          repoRoot,
          baseCommit: commitInput || 'local',
          compareCommit: isDiff ? (compareCommit || 'local') : null,
          css: config.loadCss(extensionDir),
          mermaidConfig: config.loadMermaidConfig(),
          mscgenConfig: config.loadMscgenConfig ? config.loadMscgenConfig() : null,
          frontPageData,
          crCoverPageData,
          insertOmitted: !config.isSpecRootSelection(uris),
        })
      }
    )

    const exportLabel = isDiff
      ? `HTML diff (${shortHash || 'local'} vs ${compareShortHash || 'local'})`
      : 'HTML'
    showExportNotification(
      formatExportMessage(exportLabel, result.fileCount, result.imageCount,
        shortHash ? `hash: ${shortHash}` : undefined),
      path.dirname(saveUri.fsPath)
    )
  } catch (e) {
    vscode.window.showErrorMessage(`HTML export failed: ${e.message}`)
  }
}

module.exports = { exportHtml }
