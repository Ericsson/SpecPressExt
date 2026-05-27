const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getRepoRoot } = require('specpress/lib/common/gitHelpers')
const { collectFiles, concatenateFiles } = require('specpress/lib/common/specProcessor')
const { MarkdownToDocxConverter } = require('specpress/lib/md2docx/md2docx')
const { ensureMermaidBundle } = require('specpress/lib/md2docx/handlers/mermaidHandler')
const { detectCRCoverPage } = require('specpress/lib/common/crCoverPageDetector')
const { loadCRCoverPageData } = require('specpress/lib/common/crCoverPageLoader')
const { pickCommit, collectFilesFromUris, collectFilesFromCommitUris, extractFilesFromCommit, insertOmittedMarkers, makeMermaidRenderer, findWinword } = require('./helpers')

/**
 * Creates a fileResolver from a pre-extracted cache.
 * Falls back to the local filesystem if the file isn't in the cache.
 *
 * @param {Map<string, Buffer|string>} cache - Pre-extracted file cache.
 * @returns {Function} fileResolver `(absolutePath) => Buffer|string`
 */
function makeCachedFileResolver(cache) {
  const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()
  return (filePath) => {
    if (cache.has(filePath)) return cache.get(filePath)
    const target = normPath(filePath)
    for (const [key, val] of cache) {
      if (normPath(key) === target) return val
    }
    // Fallback: read from filesystem (always returns Buffer for consistency)
    return fs.readFileSync(filePath)
  }
}

/**
 * Creates a fileResolver for local files that matches the behavior of makeCachedFileResolver.
 * Always returns Buffer for consistency.
 *
 * @returns {Function} fileResolver `(absolutePath) => Buffer`
 */
function makeLocalFileResolver() {
  return (filePath) => fs.readFileSync(filePath)
}

/**
 * Creates a text file reader from a pre-extracted cache (for concatenateFiles).
 *
 * @param {Map<string, Buffer|string>} cache - Pre-extracted file cache.
 * @returns {Function} readFile `(absolutePath) => string`
 */
function makeCachedTextReader(cache) {
  const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()
  return (filePath) => {
    if (cache.has(filePath)) {
      const content = cache.get(filePath)
      return Buffer.isBuffer(content) ? content.toString('utf8') : content
    }
    const target = normPath(filePath)
    for (const [key, val] of cache) {
      if (normPath(key) === target) {
        return Buffer.isBuffer(val) ? val.toString('utf8') : val
      }
    }
    return fs.readFileSync(filePath, 'utf8')
  }
}

/**
 * Handles the DOCX comparison (diff) command.
 *
 * @param {import('./stateManager').StateManager} state
 * @param {import('./configLoader').ConfigLoader} config
 * @param {import('vscode').ExtensionContext} context
 * @param {vscode.Uri} [uri]
 * @param {vscode.Uri[]} [allUris]
 */
async function compareDocx(state, config, context, uri, allUris) {
  // Check for winword.exe
  const winwordPath = findWinword()
  if (!winwordPath) {
    vscode.window.showErrorMessage('Microsoft Word (winword.exe) is not installed or not accessible.')
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

  const commitInput = await pickCommit(repoRoot, 'Select baseline (original) commit')
  if (!commitInput) return

  let shortHash
  try {
    shortHash = execSync(`git rev-parse --short ${commitInput}`, { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch (e) {
    vscode.window.showErrorMessage(`Invalid commit reference: ${commitInput}`)
    return
  }

  const targetInput = await pickCommit(repoRoot, 'Select revised (target) commit', { localFilesOption: true })
  if (targetInput === null) return

  let targetShortHash = null
  if (targetInput) {
    try {
      targetShortHash = execSync(`git rev-parse --short ${targetInput}`, { cwd: repoRoot, encoding: 'utf8' }).trim()
    } catch (e) {
      vscode.window.showErrorMessage(`Invalid commit reference: ${targetInput}`)
      return
    }
  }

  const authorName = await vscode.window.showInputBox({
    prompt: 'Author name for tracked changes in the comparison',
    value: 'SpecPress',
    placeHolder: 'SpecPress'
  })
  if (!authorName) return

  const insertPlaceholders = await vscode.window.showQuickPick(
    [{ label: "Yes", value: true }, { label: "No", value: false }],
    { placeHolder: "Insert placeholders for omitted sections?" }
  )
  if (!insertPlaceholders) return
  const withMarkers = insertPlaceholders.value

  const filesFromCommit = collectFilesFromCommitUris(repoRoot, uris, commitInput)
  const filesRevised = targetShortHash
    ? collectFilesFromCommitUris(repoRoot, uris, targetInput)
    : collectFilesFromUris(uris)
  if (filesFromCommit.length === 0 && filesRevised.length === 0) {
    vscode.window.showErrorMessage('No markdown or ASN.1 files found')
    return
  }

  const tmpDir = require('os').tmpdir()
  const ts = Date.now()

  // Clean up temp files from previous comparison runs
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith('specpress_') && f.endsWith('.docx')) {
        try { fs.unlinkSync(path.join(tmpDir, f)) } catch (e) { /* still open in Word */ }
      }
    }
  } catch (e) { /* ignore */ }

  const revisedLabel = targetShortHash || 'local'
  const originalDocx = path.join(tmpDir, `specpress_original_${shortHash}_${ts}.docx`)
  const revisedDocx = path.join(tmpDir, `specpress_revised_${revisedLabel}_${ts}.docx`)

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Generating DOCX files for comparison...', cancellable: false },
      async (progress) => {
        const mermaidConfig = config.loadMermaidConfig()
        const mermaidBundlePath = await ensureMermaidBundle(context.globalStorageUri.fsPath)

        const specRoot = filesFromCommit.length > 0 ? config.getSpecRootForFile(filesFromCommit[0])
          : filesRevised.length > 0 ? config.getSpecRootForFile(filesRevised[0]) : ''

        // Detect CR cover page for spec-root-level comparisons
        let crCoverPageData = null
        if (specRoot && config.isSpecRootSelection(uris)) {
          const crFilePath = detectCRCoverPage(specRoot)
          if (crFilePath) {
            const crResult = loadCRCoverPageData(crFilePath)
            if (crResult.valid) crCoverPageData = crResult.data
          }
        }

        const searchPaths = [...new Set(uris.map(u => {
          const p = u.fsPath
          return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p)
        }))]

        // Generate original DOCX from git commit
        progress.report({ message: `Loading files from ${shortHash}...` })
        if (filesFromCommit.length > 0) {
          const baselineCache = extractFilesFromCommit(repoRoot, commitInput, searchPaths)
          const readBaseline = makeCachedTextReader(baselineCache)
          const fileResolver = makeCachedFileResolver(baselineCache)

          progress.report({ message: `Generating baseline DOCX (${shortHash})...` })
          let contentCommit = concatenateFiles(filesFromCommit, readBaseline, specRoot)
          if (withMarkers && specRoot) {
            const allFiles = collectFiles([specRoot])
            contentCommit = insertOmittedMarkers(contentCommit, filesFromCommit, allFiles)
          }
          const tempMdOrig = path.join(tmpDir, `.~compare_orig_${ts}.md`)
          fs.writeFileSync(tempMdOrig, contentCommit)
          try {
            const converter = new MarkdownToDocxConverter(mermaidConfig, specRoot, makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot), fileResolver, { updateFields: false })
            await converter.convert(tempMdOrig, originalDocx, path.dirname(filesFromCommit[0]), null, { crCoverPageData })
          } finally {
            if (fs.existsSync(tempMdOrig)) fs.unlinkSync(tempMdOrig)
          }
        }

        // Generate revised DOCX
        if (filesRevised.length > 0) {
          let readRevised = undefined
          let fileResolver = makeLocalFileResolver()

          if (targetShortHash) {
            progress.report({ message: `Loading files from ${targetShortHash}...` })
            const revisedCache = extractFilesFromCommit(repoRoot, targetInput, searchPaths)
            readRevised = makeCachedTextReader(revisedCache)
            fileResolver = makeCachedFileResolver(revisedCache)
          }

          progress.report({ message: `Generating revised DOCX (${revisedLabel})...` })
          let contentRevised = concatenateFiles(filesRevised, readRevised, specRoot)
          if (withMarkers && specRoot) {
            const allFiles = collectFiles([specRoot])
            contentRevised = insertOmittedMarkers(contentRevised, filesRevised, allFiles)
          }
          const tempMdRev = path.join(tmpDir, `.~compare_rev_${ts}.md`)
          fs.writeFileSync(tempMdRev, contentRevised)
          try {
            const converter = new MarkdownToDocxConverter(mermaidConfig, specRoot, makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot), fileResolver, { updateFields: false })
            await converter.convert(tempMdRev, revisedDocx, path.dirname(filesRevised[0]), null, { crCoverPageData })
          } finally {
            if (fs.existsSync(tempMdRev)) fs.unlinkSync(tempMdRev)
          }
        }

        // Launch Word comparison via VBS script
        progress.report({ message: 'Opening Word comparison...' })
        const vbsPath = path.join(__dirname, '..', '..', 'scripts', 'compare.vbs')
        require('child_process').exec(
          `cscript //nologo "${vbsPath}" "${originalDocx}" "${revisedDocx}" "${authorName}"`,
          (err) => {
            if (err) vscode.window.showErrorMessage(`Word comparison failed: ${err.message}`)
          }
        )
      }
    )

    vscode.window.showInformationMessage(`Word comparison launched: ${shortHash} vs ${revisedLabel}`)
  } catch (e) {
    vscode.window.showErrorMessage(`Comparison failed: ${e.message}`)
    if (fs.existsSync(originalDocx)) fs.unlinkSync(originalDocx)
    if (fs.existsSync(revisedDocx)) fs.unlinkSync(revisedDocx)
  }
}

module.exports = { compareDocx }
