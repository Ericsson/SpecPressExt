const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getRepoRoot, getFileFromCommit } = require('specpress/lib/common/gitHelpers')
const { collectFiles, concatenateFiles, formatExportMessage } = require('specpress/lib/common/specProcessor')
const { MarkdownToDocxConverter } = require('specpress/lib/md2docx/md2docx')
const { ensureMermaidBundle } = require('specpress/lib/md2docx/handlers/mermaidHandler')
const { buildFrontPageDocx } = require('specpress/lib/md2docx/frontPage')
const { pickCommit, collectFilesFromUris, collectFilesFromCommitUris, insertOmittedMarkers, makeMermaidRenderer, formatExportTimestamp, showExportNotification } = require('./helpers')

/**
 * Handles the DOCX export command.
 *
 * @param {import('./stateManager').StateManager} state
 * @param {import('./configLoader').ConfigLoader} config
 * @param {import('vscode').ExtensionContext} context
 * @param {vscode.Uri} [uri]
 * @param {vscode.Uri[]} [allUris]
 */
async function exportDocx(state, config, context, uri, allUris) {
  const uris = allUris || (uri ? [uri] : await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: true,
    filters: { 'Markdown': ['md', 'markdown', 'asn'] }
  }))
  if (!uris) return

  let repoRoot
  try {
    repoRoot = getRepoRoot(fs.statSync(uris[0].fsPath).isDirectory() ? uris[0].fsPath : path.dirname(uris[0].fsPath))
  } catch (e) {
    repoRoot = null
  }

  let commitInput = null
  let shortHash = null
  if (repoRoot) {
    commitInput = await pickCommit(repoRoot, 'Select version for DOCX export', { localFilesOption: true })
    if (commitInput === null) return

    if (commitInput) {
      try {
        shortHash = execSync(`git rev-parse --short ${commitInput}`, { cwd: repoRoot, encoding: 'utf8' }).trim()
      } catch (e) {
        vscode.window.showErrorMessage(`Invalid commit reference: ${commitInput}`)
        return
      }
    }
  }

  const files = shortHash
    ? collectFilesFromCommitUris(repoRoot, uris, commitInput)
    : collectFilesFromUris(uris)
  if (files.length === 0) {
    vscode.window.showErrorMessage(shortHash ? `No markdown or ASN.1 files found in ${commitInput}` : 'No markdown or ASN.1 files found in selection')
    return
  }

  const ts = formatExportTimestamp()
  const defaultName = shortHash ? `${ts} Export_${shortHash}.docx` : `${ts} Export.docx`
  const saveUri = await vscode.window.showSaveDialog({
    filters: { 'Word Document': ['docx'] },
    defaultUri: vscode.Uri.file(path.join(config.getExportFolder(state.lastExportFolder), defaultName))
  })
  if (!saveUri) return
  state.lastExportFolder = path.dirname(saveUri.fsPath)

  let outputPath = saveUri.fsPath
  if (shortHash) {
    const parsed = path.parse(outputPath)
    if (!parsed.name.includes(shortHash)) {
      outputPath = path.join(parsed.dir, `${parsed.name}_${shortHash}${parsed.ext}`)
    }
  }

  try {
    let imageCount = 0
    const specRoot = config.getSpecRootForFile(files[0])
    const label = shortHash ? `${commitInput} (${shortHash})` : 'local files'
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting DOCX from ${label}...`, cancellable: false },
      async () => {
        const readFile = shortHash ? (f) => getFileFromCommit(repoRoot, f, commitInput) : undefined
        let content = concatenateFiles(files, readFile, specRoot)
        if (specRoot && !config.isSpecRootSelection(uris)) {
          const allFiles = collectFiles([specRoot])
          if (files.length < allFiles.length) {
            content = insertOmittedMarkers(content, files, allFiles)
          }
        }
        const tmpDir = require('os').tmpdir()
        const timestamp = Date.now()
        const tempMd = path.join(tmpDir, `.~export_${timestamp}.md`)
        fs.writeFileSync(tempMd, content)

        try {
          const mermaidConfig = config.loadMermaidConfig()
          const mermaidBundlePath = await ensureMermaidBundle(context.globalStorageUri.fsPath)

          const converter = new MarkdownToDocxConverter(mermaidConfig, specRoot, makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot))

          let frontPage = null
          if (config.isSpecRootSelection(uris)) {
            const data = config.loadFrontPageData()
            if (data) {
              try {
                frontPage = buildFrontPageDocx(data)
              } catch (e) {
                vscode.window.showWarningMessage(`Front page failed: ${e.message}`)
              }
            }
          }

          await converter.convert(tempMd, outputPath, path.dirname(files[0]), frontPage)
          imageCount = converter.imageCount
        } finally {
          if (fs.existsSync(tempMd)) fs.unlinkSync(tempMd)
        }
      }
    )

    showExportNotification(formatExportMessage('DOCX', files.length, imageCount, shortHash ? `hash: ${shortHash}` : undefined), path.dirname(outputPath))
  } catch (e) {
    vscode.window.showErrorMessage(`DOCX export failed: ${e.message}`)
  }
}

module.exports = { exportDocx }
