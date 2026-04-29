const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getRepoRoot, getFileFromCommit } = require('specpress/lib/common/gitHelpers')
const { concatenateFiles, formatExportMessage } = require('specpress/lib/common/specProcessor')
const { MarkdownToDocxConverter } = require('specpress/lib/md2docx/md2docx')
const { ensureMermaidBundle } = require('specpress/lib/md2docx/handlers/mermaidHandler')
const { buildCoverSections } = require('specpress/lib/md2docx/coverPage')
const { pickCommit, collectFilesFromUris, collectFilesFromCommitUris, makeMermaidRenderer, formatExportTimestamp, showExportNotification } = require('./helpers')

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
        const content = concatenateFiles(files, readFile, specRoot)
        const tmpDir = require('os').tmpdir()
        const timestamp = Date.now()
        const tempMd = path.join(tmpDir, `.~export_${timestamp}.md`)
        fs.writeFileSync(tempMd, content)

        try {
          const mermaidConfig = config.loadMermaidConfig(path.join(__dirname, '../..'))
          const mermaidBundlePath = await ensureMermaidBundle(context.globalStorageUri.fsPath)
          let mermaidConfigPath = null
          if (mermaidConfig !== '{}') {
            mermaidConfigPath = path.join(tmpDir, `.~mermaid_${timestamp}.json`)
            fs.writeFileSync(mermaidConfigPath, mermaidConfig)
          }

          const converter = new MarkdownToDocxConverter(mermaidConfigPath, specRoot, makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot))

          let coverSections = null
          if (config.isSpecRootSelection(uris)) {
            const dataFile = config.coverPageData
            if (dataFile) {
              const wsRoot = config.wsRoot
              const datPath = path.isAbsolute(dataFile) ? dataFile : path.join(wsRoot, dataFile)
              if (fs.existsSync(datPath)) {
                try {
                  const data = JSON.parse(fs.readFileSync(datPath, 'utf8'))
                  const tplFile = config.coverPageTemplate
                  const assetsDir = tplFile ? path.dirname(path.isAbsolute(tplFile) ? tplFile : path.join(wsRoot, tplFile)) : ''
                  coverSections = buildCoverSections(data, assetsDir)
                } catch (e) {
                  vscode.window.showWarningMessage(`Cover page failed: ${e.message}`)
                }
              }
            }
          }

          await converter.convert(tempMd, outputPath, path.dirname(files[0]), coverSections)
          imageCount = converter.imageCount

          if (mermaidConfigPath && fs.existsSync(mermaidConfigPath)) fs.unlinkSync(mermaidConfigPath)
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
