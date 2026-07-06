const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getRepoRoot, extractFilesFromCommit, makeCachedFileResolver, makeCachedTextReader } = require('specpress/lib/common/gitHelpers')
const { collectFiles, concatenateFiles, insertOmittedMarkers } = require('specpress/lib/common/specProcessor')
const { MarkdownToDocxConverter } = require('specpress/lib/md2docx/md2docx')
const { ensureMermaidBundle } = require('specpress/lib/md2docx/handlers/mermaidHandler')
const { mergeDocxVersions, detectBackends } = require('specpress/lib/common/docxMerge')
const { pickCommit, collectFilesFromUris, collectFilesFromCommitUris, makeMermaidRenderer, formatExportTimestamp, showExportNotification, generateCRFilename } = require('./helpers')
const { selectCoverPage } = require('./coverPageSelector')

const MAX_VERSIONS = 5
const DEBUG_MODE = false // Set to false to clean up temp files

/**
 * Handles the DOCX comparison (diff) command with multi-version support.
 */
async function compareDocx(state, config, context, uri, allUris) {
  // Check for available merge backends
  const backends = detectBackends()
  if (!backends.word && !backends.libreoffice) {
    vscode.window.showErrorMessage('No merge backend available. Install Microsoft Word (Windows) or LibreOffice.')
    return
  }

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
    vscode.window.showErrorMessage('DOCX comparison requires a git repository to compare versions.')
    return
  }

  // Collect versions (minimum 2, maximum 5)
  // versions[0] = v1 (baseline, authorName: null)
  // versions[1] = v2 (authorName: "author2" for changes v1→v2)
  // versions[2] = v3 (authorName: "author3" for changes v2→v3)
  // etc.
  const versions = []
  let continueAdding = true

  while (continueAdding && versions.length < MAX_VERSIONS) {
    const versionNum = versions.length + 1
    const isThirdOrLater = versionNum >= 3

    const commitInput = await pickCommit(
      repoRoot,
      `Select version ${versionNum} (or cancel to ${versions.length < 2 ? 'abort' : 'finish'})`,
      { localFilesOption: versionNum > 1, noneOption: isThirdOrLater }
    )

    if (commitInput === null) {
      if (versions.length < 2) {
        vscode.window.showInformationMessage('DOCX comparison requires at least 2 versions.')
        return
      }
      break
    }

    // Handle "None" selection - pickCommit returns 'NONE' for the None option
    if (commitInput === 'NONE') {
      break
    }

    let shortHash = null
    let label = 'local files'
    let commitMessage = null

    if (commitInput) {
      try {
        shortHash = execSync(`git rev-parse --short ${commitInput}`, { cwd: repoRoot, encoding: 'utf8' }).trim()

        // Get commit message for author name suggestion
        commitMessage = execSync(`git log -1 --format=%s ${commitInput}`, { cwd: repoRoot, encoding: 'utf8' }).trim()

        label = shortHash
      } catch (e) {
        vscode.window.showErrorMessage(`Invalid commit reference: ${commitInput}`)
        return
      }
    }

    // Only ask for author name for transitions (v1→v2, v2→v3, etc.)
    let authorName = null
    if (versions.length > 0) {
      // Generate smart default author name
      let defaultAuthor
      if (shortHash && commitMessage) {
        // Format: shortHash_first40charsOfMessage
        const messageSanitized = commitMessage
          .substring(0, 40)
          .replace(/[<>:"/\\|?*]/g, '_')  // Replace invalid chars
          .replace(/\s+/g, '_')            // Replace spaces with underscore
          .replace(/_+/g, '_')             // Collapse multiple underscores
          .replace(/^_|_$/g, '')           // Trim leading/trailing underscores
        defaultAuthor = `${shortHash}_${messageSanitized}`
      } else {
        // Fallback for local files or if commit message unavailable
        defaultAuthor = `Author${versions.length}`
      }

      authorName = await vscode.window.showInputBox({
        prompt: `Author name for changes introduced by version ${versionNum} (${label})`,
        value: defaultAuthor,
        placeHolder: 'Author name for tracked changes'
      })
      if (!authorName) return
    }

    versions.push({ commitInput, shortHash, label, authorName, commitMessage })
  }

  if (versions.length < 2) {
    vscode.window.showInformationMessage('DOCX comparison requires at least 2 versions.')
    return
  }

  const insertPlaceholders = await vscode.window.showQuickPick(
    [{ label: "Yes", value: true }, { label: "No", value: false }],
    { placeHolder: "Insert placeholders for omitted sections?" }
  )
  if (!insertPlaceholders) return
  const withMarkers = insertPlaceholders.value

  // Collect files from first version to determine spec root
  const firstFiles = versions[0].commitInput
    ? collectFilesFromCommitUris(repoRoot, uris, versions[0].commitInput)
    : collectFilesFromUris(uris)

  if (firstFiles.length === 0) {
    vscode.window.showErrorMessage('No markdown or ASN.1 files found')
    return
  }

  const specRoot = config.getSpecRootForFile(firstFiles[0])

  // Build default filename
  const ts = formatExportTimestamp()
  let defaultName

  // Check if spec root has a CR cover page (CRxxxx.json)
  let crFilename = null
  if (specRoot) {
    const { detectCRCoverPage } = require('specpress/lib/common/crCoverPageDetector')
    const { loadCRCoverPageData } = require('specpress/lib/common/crCoverPageLoader')

    const crFilePath = detectCRCoverPage(specRoot)
    if (crFilePath) {
      const crResult = loadCRCoverPageData(crFilePath)
      if (crResult.valid && crResult.data) {
        crFilename = generateCRFilename(crResult.data)
      }
    }
  }

  // Use CR-based filename if available, otherwise use version labels
  if (crFilename) {
    defaultName = crFilename
  } else {
    const versionLabels = versions.map(v => v.label).join('_')
    defaultName = `${ts} DIFF_${versionLabels}.docx`
  }

  const saveUri = await vscode.window.showSaveDialog({
    filters: { 'Word Document': ['docx'] },
    defaultUri: vscode.Uri.file(path.join(config.getExportFolder(state.lastExportFolder), defaultName))
  })
  if (!saveUri) return
  state.lastExportFolder = path.dirname(saveUri.fsPath)

  const outputPath = saveUri.fsPath
  const tmpDir = require('os').tmpdir()
  const timestamp = Date.now()

  // Clean up old temp files
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith('specpress_diff_') && f.endsWith('.docx')) {
        try { fs.unlinkSync(path.join(tmpDir, f)) } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Generating DOCX comparison...', cancellable: false },
      async (progress) => {
        const mermaidConfig = config.loadMermaidConfig()
        const mermaidBundlePath = await ensureMermaidBundle(context.globalStorageUri.fsPath)

        // Select cover page (CR, standard front page, or none)
        const coverPageChoice = await selectCoverPage(config, specRoot)
        if (!coverPageChoice) return // User cancelled

        const crCoverPageData = coverPageChoice.crData || null

        const searchPaths = [...new Set(uris.map(u => {
          const p = u.fsPath
          return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p)
        }))]

        // Generate DOCX for each version
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
            const cache = extractFilesFromCommit(repoRoot, v.commitInput, searchPaths)
            readFile = makeCachedTextReader(cache)
            fileResolver = makeCachedFileResolver(cache)
          }

          let content = concatenateFiles(files, readFile, specRoot)
          if (withMarkers && specRoot) {
            const allFiles = collectFiles([specRoot])
            content = insertOmittedMarkers(content, files, allFiles)
          }

          const tempMd = path.join(tmpDir, `.~diff_v${i + 1}_${timestamp}.md`)
          fs.writeFileSync(tempMd, content)

          const docxPath = path.join(tmpDir, `specpress_diff_v${i + 1}_${v.label}_${timestamp}.docx`)

          try {
            const converter = new MarkdownToDocxConverter(
              mermaidConfig,
              specRoot,
              makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot),
              fileResolver,
              { updateFields: false }
            )
            await converter.convert(tempMd, docxPath, path.dirname(files[0]), null, { crCoverPageData })
          } finally {
            if (fs.existsSync(tempMd)) fs.unlinkSync(tempMd)
          }

          docxFiles.push(docxPath)
        }

        // Merge via specpress unified API
        progress.report({ message: 'Starting document comparison...' })

        const baseDocx = docxFiles[0]
        const revisions = versions.slice(1).map((v, i) => ({
          docxPath: docxFiles[i + 1],
          authorName: v.authorName
        }))

        await mergeDocxVersions(baseDocx, revisions, outputPath, {
          backend: 'auto',
          debug: DEBUG_MODE,
          onProgress: (msg) => progress.report({ message: msg })
        })

        // Clean up temp DOCX files (unless debug mode is enabled)
        if (!DEBUG_MODE) {
          for (const f of docxFiles) {
            try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch (e) { /* ignore */ }
          }
        } else {
          console.log('Debug mode: Keeping generated DOCX files:')
          docxFiles.forEach((f, i) => console.log(`  v${i + 1}: ${f}`))
        }
      }
    )

    const versionSummary = versions.map((v, i) => `v${i + 1}: ${v.label}`).join(', ')
    showExportNotification(
      `DOCX comparison completed: ${versionSummary}`,
      path.dirname(outputPath),
      outputPath
    )
  } catch (e) {
    vscode.window.showErrorMessage(`DOCX comparison failed: ${e.message}`)
  }
}

module.exports = { compareDocx }
