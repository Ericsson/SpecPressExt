const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { getRepoRoot } = require('specpress/lib/common/gitHelpers')
const { createCommitResolver } = require('specpress/lib/common/fileResolver')
const { cleanupDiagramCache } = require('specpress/lib/common/diagramCache')
const { collectFiles, concatenateFiles, formatExportMessage } = require('specpress/lib/common/specProcessor')
const { Md2Docx } = require('specpress/lib/md2docx/md2docx')
const { ensureMermaidBundle } = require('specpress/lib/md2docx/handlers/mermaidHandler')
const { loadCRCoverPageData } = require('specpress/lib/common/crCoverPageLoader')
const { mergeDocxVersions, detectBackends } = require('specpress/lib/common/docxMerge')
const { pickVersions, collectFilesFromUris, collectFilesFromCommitUris, insertOmittedMarkers, makeMermaidRenderer, formatExportTimestamp, showExportNotification, generateCRFilename, warnIfMscgenMissing } = require('./helpers')
const { selectCoverPage } = require('./coverPageSelector')

const DEBUG_MODE = false

/**
 * Handles the DOCX export command.
 * For a single version: normal DOCX export.
 * For 2-5 versions: DOCX diff with tracked changes (requires Word or LibreOffice).
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

  // Determine max versions based on available merge backend
  const backends = repoRoot ? detectBackends() : null
  const maxVersions = !backends ? 1
    : backends.word ? 5
    : backends.libreoffice ? 2
    : 1

  // Pick versions with author names interleaved
  const versions = repoRoot
    ? await pickVersions(repoRoot, 'Select version for DOCX export', 'Add version for DOCX diff (or choose None to export single version)', maxVersions, true)
    : [{ commitInput: null, shortHash: null, label: 'local', authorName: null }]
  if (versions === null) return

  const isDiff = versions.length > 1

  // For diff: check backend availability
  if (isDiff) {
    if (!backends || (!backends.word && !backends.libreoffice)) {
      vscode.window.showErrorMessage('No merge backend available. Install Microsoft Word (Windows) or LibreOffice.')
      return
    }
  }

  const firstFiles = versions[0].commitInput
    ? collectFilesFromCommitUris(repoRoot, uris, versions[0].commitInput)
    : collectFilesFromUris(uris)
  if (firstFiles.length === 0) {
    vscode.window.showErrorMessage('No markdown or ASN.1 files found in selection')
    return
  }

  const specRoot = config.getSpecRootForFile(firstFiles[0])

  // Cover page selection (before save dialog)
  const coverPageChoice = await selectCoverPage(config, specRoot)
  if (!coverPageChoice) return

  const frontPageData = coverPageChoice.type === 'standard' ? coverPageChoice.frontPage : null
  const crCoverPageData = coverPageChoice.type === 'cr' ? coverPageChoice.crData : null

  // Build default filename
  const ts = formatExportTimestamp()
  let defaultName
  if (isDiff) {
    // Try CR-based filename
    let crFilename = null
    if (specRoot) {
      const { detectCRCoverPage } = require('specpress/lib/common/crCoverPageDetector')
      const crFilePath = detectCRCoverPage(specRoot)
      if (crFilePath) {
        const crResult = loadCRCoverPageData(crFilePath)
        if (crResult.valid && crResult.data) crFilename = generateCRFilename(crResult.data)
      }
    }
    defaultName = crFilename || `${ts} DIFF_${versions.map(v => v.label).join('_')}.docx`
  } else {
    const { shortHash, commitInput } = versions[0]
    defaultName = shortHash ? `${ts} Export_${shortHash}.docx` : `${ts} Export.docx`
  }

  const saveUri = await vscode.window.showSaveDialog({
    filters: { 'Word Document': ['docx'] },
    defaultUri: vscode.Uri.file(path.join(config.getExportFolder(state.lastExportFolder), defaultName))
  })
  if (!saveUri) return
  state.lastExportFolder = path.dirname(saveUri.fsPath)

  let outputPath = saveUri.fsPath
  if (!isDiff && versions[0].shortHash) {
    const parsed = path.parse(outputPath)
    if (!parsed.name.includes(versions[0].shortHash)) {
      outputPath = path.join(parsed.dir, `${parsed.name}_${versions[0].shortHash}${parsed.ext}`)
    }
  }

  if (isDiff) {
    await _exportDiff(state, config, context, uris, versions, repoRoot, specRoot, crCoverPageData, outputPath)
  } else {
    await _exportSingle(state, config, context, uris, versions[0], repoRoot, specRoot, firstFiles, frontPageData, crCoverPageData, outputPath)
  }
}

async function _exportSingle(state, config, context, uris, version, repoRoot, specRoot, files, frontPageData, crCoverPageData, outputPath) {
  const { commitInput, shortHash, label } = version
  try {
    let imageCount = 0
    warnIfMscgenMissing()
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting DOCX from ${label}...`, cancellable: false },
      async () => {
        let fileResolver = null
        let resolver = null
        if (shortHash && specRoot) {
          resolver = createCommitResolver(repoRoot, specRoot, commitInput)
          fileResolver = (f) => resolver.readFile(f)
        }

        const readFile = shortHash ? (f) => resolver.readFile(f, 'utf8') : undefined
        let content = concatenateFiles(files, readFile, specRoot)
        if (specRoot && !config.isSpecRootSelection(uris)) {
          const allFiles = collectFiles([specRoot])
          if (files.length < allFiles.length) content = insertOmittedMarkers(content, files, allFiles)
        }

        const mermaidConfig = config.loadMermaidConfig()
        const mermaidBundlePath = await ensureMermaidBundle(context.globalStorageUri.fsPath)
        const converterOpts = { mermaidConfig, specRootPath: specRoot, mermaidRenderer: makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot) }
        if (fileResolver) converterOpts.fileResolver = fileResolver
        const converter = new Md2Docx(converterOpts)

        await converter.convert(content, outputPath, path.dirname(files[0]), frontPageData, { crCoverPageData })
        imageCount = converter.imageCount

        if (!shortHash && specRoot) {
          try { cleanupDiagramCache(specRoot, { mermaidConfig: config.loadMermaidConfig() }) } catch (e) {}
        }
      }
    )
    showExportNotification(formatExportMessage('DOCX', files.length, imageCount, version.shortHash ? `hash: ${version.shortHash}` : undefined), path.dirname(outputPath), outputPath)
  } catch (e) {
    vscode.window.showErrorMessage(`DOCX export failed: ${e.message}`)
  }
}

async function _exportDiff(state, config, context, uris, versions, repoRoot, specRoot, crCoverPageData, outputPath) {
  const tmpDir = require('os').tmpdir()
  const timestamp = Date.now()

  // Clean up old temp files
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith('specpress_diff_') && f.endsWith('.docx')) {
        try { fs.unlinkSync(path.join(tmpDir, f)) } catch (e) {}
      }
    }
  } catch (e) {}

  // Ask about omitted section markers
  const insertPlaceholders = await vscode.window.showQuickPick(
    [{ label: 'Yes', value: true }, { label: 'No', value: false }],
    { placeHolder: 'Insert placeholders for omitted sections?' }
  )
  if (!insertPlaceholders) return
  const withMarkers = insertPlaceholders.value

  try {
    warnIfMscgenMissing()
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Generating DOCX comparison...', cancellable: false },
      async (progress) => {
        const mermaidConfig = config.loadMermaidConfig()
        const mermaidBundlePath = await ensureMermaidBundle(context.globalStorageUri.fsPath)

        const docxFiles = []
        for (let i = 0; i < versions.length; i++) {
          const v = versions[i]
          progress.report({ message: `Generating DOCX for version ${i + 1} (${v.label})...` })

          const files = v.commitInput
            ? collectFilesFromCommitUris(repoRoot, uris, v.commitInput)
            : collectFilesFromUris(uris)

          let readFile = undefined
          let fileResolver = null
          if (v.commitInput) {
            const resolver = createCommitResolver(repoRoot, specRoot, v.commitInput)
            readFile = (f) => resolver.readFile(f, 'utf8')
            fileResolver = (f) => resolver.readFile(f)
          }

          let content = concatenateFiles(files, readFile, specRoot)
          if (withMarkers && specRoot) {
            const allFiles = collectFiles([specRoot])
            content = insertOmittedMarkers(content, files, allFiles)
          }

          const docxPath = path.join(tmpDir, `specpress_diff_v${i + 1}_${v.label}_${timestamp}.docx`)
          const converter = new Md2Docx({
            updateFields: false,
            mermaidConfig,
            specRootPath: specRoot,
            mermaidRenderer: makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot),
            fileResolver: fileResolver || undefined
          })
          await converter.convert(content, docxPath, path.dirname(files[0]), null, { crCoverPageData })
          docxFiles.push(docxPath)
        }

        progress.report({ message: 'Starting document comparison...' })
        const revisions = versions.slice(1).map((v, i) => ({ docxPath: docxFiles[i + 1], authorName: v.authorName }))
        await mergeDocxVersions(docxFiles[0], revisions, outputPath, {
          backend: 'auto',
          debug: DEBUG_MODE,
          onProgress: (msg) => progress.report({ message: msg })
        })

        if (!DEBUG_MODE) {
          for (const f of docxFiles) {
            try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch (e) {}
          }
        }
      }
    )

    const versionSummary = versions.map((v, i) => `v${i + 1}: ${v.label}`).join(', ')
    showExportNotification(`DOCX comparison completed: ${versionSummary}`, path.dirname(outputPath), outputPath)
  } catch (e) {
    vscode.window.showErrorMessage(`DOCX comparison failed: ${e.message}`)
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
