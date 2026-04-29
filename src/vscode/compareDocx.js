const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getRepoRoot, getFileFromCommit } = require('specpress/lib/common/gitHelpers')
const { concatenateFiles } = require('specpress/lib/common/specProcessor')
const { MarkdownToDocxConverter } = require('specpress/lib/md2docx/md2docx')
const { ensureMermaidBundle } = require('specpress/lib/md2docx/handlers/mermaidHandler')
const { pickCommit, collectFilesFromUris, collectFilesFromCommitUris, makeMermaidRenderer } = require('./helpers')

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
  // Check for winword.exe via registry
  let winwordPath
  try {
    winwordPath = execSync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Winword.exe" /ve', { encoding: 'utf8' })
    const match = winwordPath.match(/REG_SZ\s+(.+)/)
    winwordPath = match ? match[1].trim() : null
  } catch (e) {
    winwordPath = null
  }
  if (!winwordPath || !fs.existsSync(winwordPath)) {
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
        const mermaidConfig = config.loadMermaidConfig(path.join(__dirname, '../..'))
        const mermaidBundlePath = await ensureMermaidBundle(context.globalStorageUri.fsPath)
        let mermaidConfigPath = null
        if (mermaidConfig !== '{}') {
          mermaidConfigPath = path.join(tmpDir, `.~mermaid_${ts}.json`)
          fs.writeFileSync(mermaidConfigPath, mermaidConfig)
        }

        const specRoot = filesFromCommit.length > 0 ? config.getSpecRootForFile(filesFromCommit[0])
          : filesRevised.length > 0 ? config.getSpecRootForFile(filesRevised[0]) : ''

        // Generate original DOCX from git commit
        progress.report({ message: `Generating baseline from ${commitInput} (${shortHash})...` })
        if (filesFromCommit.length > 0) {
          const contentCommit = concatenateFiles(filesFromCommit, (f) => getFileFromCommit(repoRoot, f, commitInput), specRoot)
          const tempMdOrig = path.join(tmpDir, `.~compare_orig_${ts}.md`)
          fs.writeFileSync(tempMdOrig, contentCommit)
          try {
            const converter = new MarkdownToDocxConverter(mermaidConfigPath, specRoot, makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot))
            await converter.convert(tempMdOrig, originalDocx, path.dirname(filesFromCommit[0]))
          } finally {
            if (fs.existsSync(tempMdOrig)) fs.unlinkSync(tempMdOrig)
          }
        }

        // Generate revised DOCX
        progress.report({ message: targetShortHash ? `Generating revised from ${targetInput} (${targetShortHash})...` : 'Generating revised from local files...' })
        if (filesRevised.length > 0) {
          const readRevised = targetShortHash ? (f) => getFileFromCommit(repoRoot, f, targetInput) : undefined
          const contentRevised = concatenateFiles(filesRevised, readRevised, specRoot)
          const tempMdRev = path.join(tmpDir, `.~compare_rev_${ts}.md`)
          fs.writeFileSync(tempMdRev, contentRevised)
          try {
            const converter = new MarkdownToDocxConverter(mermaidConfigPath, specRoot, makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot))
            await converter.convert(tempMdRev, revisedDocx, path.dirname(filesRevised[0]))
          } finally {
            if (fs.existsSync(tempMdRev)) fs.unlinkSync(tempMdRev)
          }
        }

        if (mermaidConfigPath && fs.existsSync(mermaidConfigPath)) fs.unlinkSync(mermaidConfigPath)

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
