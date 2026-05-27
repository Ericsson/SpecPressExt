const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getRepoRoot, getFileFromCommit } = require('specpress/lib/common/gitHelpers')
const { collectFiles, concatenateFiles, formatExportMessage } = require('specpress/lib/common/specProcessor')
const { MarkdownToDocxConverter } = require('specpress/lib/md2docx/md2docx')
const { ensureMermaidBundle } = require('specpress/lib/md2docx/handlers/mermaidHandler')
const { buildFrontPageDocx } = require('specpress/lib/md2docx/frontPage')
const { detectCRCoverPage } = require('specpress/lib/common/crCoverPageDetector')
const { loadCRCoverPageData } = require('specpress/lib/common/crCoverPageLoader')
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
  let uris = allUris || (uri ? [uri] : await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: true,
    filters: { 'Markdown': ['md', 'markdown', 'asn'] }
  }))
  if (!uris) return

  // If a single CR JSON file is selected, export just the CR cover page as DOCX
  if (uris.length === 1) {
    const selected = uris[0].fsPath
    const basename = path.basename(selected)
    const dir = path.basename(path.dirname(selected))
    if (dir.toLowerCase() === 'history' && /^CR[x\d]{4}\.json$/i.test(basename)) {
      await exportCRCoverOnly(state, config, context, selected)
      return
    }
  }

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

          // Build file resolver for git commits
          let fileResolver = null
          if (shortHash) {
            const { extractFilesFromCommit } = require('./helpers')
            const searchPaths = [...new Set(uris.map(u => {
              const p = u.fsPath
              return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p)
            }))]
            const fileCache = extractFilesFromCommit(repoRoot, commitInput, searchPaths)
            const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()
            fileResolver = (filePath) => {
              if (fileCache.has(filePath)) return fileCache.get(filePath)
              const target = normPath(filePath)
              for (const [key, val] of fileCache) {
                if (normPath(key) === target) return val
              }
              return fs.readFileSync(filePath)
            }
          }

          const converter = new MarkdownToDocxConverter(mermaidConfig, specRoot, makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot), fileResolver)

          let frontPage = null
          let crCoverPageData = null
          
          if (config.isSpecRootSelection(uris)) {
            // Detect what's available
            const crFilePath = specRoot ? detectCRCoverPage(specRoot) : null
            const hasFrontPageData = config.loadFrontPageData() !== null
            
            // Build options list with availability status
            const options = []
            
            if (crFilePath) {
              // Validate CR cover page data
              const crResult = loadCRCoverPageData(crFilePath)
              
              if (crResult.valid) {
                options.push({
                  label: `$(file) CR Cover Page (${path.basename(crFilePath)})`,
                  description: '',
                  value: 'cr',
                  crData: crResult.data
                })
              } else {
                options.push({
                  label: `$(error) CR Cover Page (${path.basename(crFilePath)})`,
                  description: 'Invalid - ' + crResult.errors[0],
                  value: 'cr-invalid',
                  errors: crResult.errors,
                  crFilePath
                })
              }
            }
            
            if (hasFrontPageData) {
              options.push({
                label: '$(book) Standard Front Page',
                description: '',
                value: 'standard'
              })
            }
            
            options.push({
              label: '$(circle-slash) No Front Page',
              description: '',
              value: 'none'
            })
            
            // Show quick pick if there are choices
            if (options.length > 1) {
              const choice = await vscode.window.showQuickPick(options, {
                placeHolder: 'Select front page type for export'
              })
              
              if (!choice) return // User cancelled
              
              if (choice.value === 'cr-invalid') {
                // Show detailed error and offer to open file
                const errorMsg = `CR cover page validation failed:\n\n${choice.errors.join('\n')}\n\nClick "Open CR File" to fix the errors.`
                const action = await vscode.window.showErrorMessage(errorMsg, 'Open CR File', 'Cancel')
                
                if (action === 'Open CR File') {
                  await vscode.window.showTextDocument(vscode.Uri.file(choice.crFilePath))
                }
                return
              }
              
              if (choice.value === 'cr') {
                crCoverPageData = choice.crData
              } else if (choice.value === 'standard') {
                const data = config.loadFrontPageData()
                if (data) {
                  try {
                    frontPage = buildFrontPageDocx(data)
                  } catch (e) {
                    vscode.window.showWarningMessage(`Front page failed: ${e.message}`)
                  }
                }
              }
              // If choice.value === 'none', both stay null
            } else if (options.length === 1 && options[0].value !== 'none') {
              // Only one option available (not counting 'none') - use it automatically
              if (options[0].value === 'cr') {
                crCoverPageData = options[0].crData
              } else if (options[0].value === 'standard') {
                const data = config.loadFrontPageData()
                if (data) {
                  try {
                    frontPage = buildFrontPageDocx(data)
                  } catch (e) {
                    vscode.window.showWarningMessage(`Front page failed: ${e.message}`)
                  }
                }
              }
            }
          }

          await converter.convert(tempMd, outputPath, path.dirname(files[0]), frontPage, { crCoverPageData })
          imageCount = converter.imageCount
        } finally {
          if (fs.existsSync(tempMd)) fs.unlinkSync(tempMd)
        }
      }
    )

    showExportNotification(formatExportMessage('DOCX', files.length, imageCount, shortHash ? `hash: ${shortHash}` : undefined), path.dirname(outputPath), outputPath)
  } catch (e) {
    vscode.window.showErrorMessage(`DOCX export failed: ${e.message}`)
  }
}

/**
 * Exports a standalone DOCX containing only the rendered CR cover page.
 */
async function exportCRCoverOnly(state, config, context, crFilePath) {
  const crResult = loadCRCoverPageData(crFilePath)
  if (!crResult.valid) {
    const action = await vscode.window.showErrorMessage(
      `CR cover page validation failed:\n${crResult.errors.join('\n')}`, 'Open CR File')
    if (action === 'Open CR File') await vscode.window.showTextDocument(vscode.Uri.file(crFilePath))
    return
  }

  const ts = formatExportTimestamp()
  const defaultName = `${ts} CR Cover Page.docx`
  const saveUri = await vscode.window.showSaveDialog({
    filters: { 'Word Document': ['docx'] },
    defaultUri: vscode.Uri.file(path.join(config.getExportFolder(state.lastExportFolder), defaultName))
  })
  if (!saveUri) return
  state.lastExportFolder = path.dirname(saveUri.fsPath)

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Exporting CR cover page DOCX...', cancellable: false },
      async () => {
        const { exportCRCoverPageDocx } = require('specpress/lib/md2docx/crCoverPageRenderer')
        await exportCRCoverPageDocx(crFilePath, saveUri.fsPath)
      }
    )
    showExportNotification('CR cover page exported to DOCX.', path.dirname(saveUri.fsPath), saveUri.fsPath)
  } catch (e) {
    vscode.window.showErrorMessage(`CR cover page DOCX export failed: ${e.message}`)
  }
}

module.exports = { exportDocx }
