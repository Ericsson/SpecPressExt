const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getGitLog } = require('specpress/lib/common/gitHelpers')
const { collectFiles } = require('specpress/lib/common/specProcessor')
const { collectFilesFromCommit, extractFilesFromCommit } = require('specpress/lib/common/gitHelpers')
const { insertOmittedMarkers } = require('specpress/lib/common/specProcessor')
const { findWinword } = require('specpress/lib/common/docxMerge')

const NOT_CONFIGURED_MSG = 'SpecPress: specpress.specificationRootPath is not configured. Set it in workspace settings to enable SpecPress features.'

/**
 * Returns a timestamp string formatted as "YYYY-MM-DD HH-MM-SS".
 * @returns {string}
 */
function formatExportTimestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

/**
 * Shows an info notification with an "Open Folder" button.
 * @param {string} message - Notification text.
 * @param {string} folderPath - Directory to open on button click.
 */
async function showExportNotification(message, folderPath, filePath) {
  const buttons = ['Open Folder']
  let winwordPath = null
  if (filePath && filePath.endsWith('.docx')) {
    winwordPath = findWinword()
    if (winwordPath) buttons.unshift('Open in Word')
  }
  const choice = await vscode.window.showInformationMessage(message, ...buttons)
  if (choice === 'Open in Word') {
    require('child_process').exec(`"${winwordPath}" "${filePath}"`)
  } else if (choice === 'Open Folder') {
    const { exec } = require('child_process')
    if (process.platform === 'win32') exec(`explorer "${folderPath}"`)
    else if (process.platform === 'darwin') exec(`open "${folderPath}"`)
    else if (process.platform === 'linux') exec(`xdg-open "${folderPath}"`)
    else vscode.env.openExternal(vscode.Uri.file(folderPath))
  }
}

/**
 * Shows a QuickPick with recent git commits for the user to choose from.
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} prompt - Placeholder text for the QuickPick.
 * @param {{localFilesOption?: boolean, noneOption?: boolean}} [options] - If localFilesOption is true, adds a "Local files" item. If noneOption is true, adds a "None" item at the top.
 * @returns {Promise<string|null>} The selected commit reference, empty string for local files, 'NONE' for none option, or null if cancelled.
 */
async function pickCommit(repoRoot, prompt, options = {}) {
  const items = []

  if (options.noneOption) {
    items.push({ label: '$(circle-slash) None (finish with current versions)', description: '', commitRef: 'NONE', alwaysShow: true })
  }

  if (options.localFilesOption) {
    items.push({ label: '$(file-directory) Local files (current workspace)', description: '', commitRef: '', alwaysShow: true })
  }

  try {
    const log = getGitLog(repoRoot)
    for (const entry of log) {
      const refs = entry.refNames ? ` (${entry.refNames})` : ''
      items.push({
        label: `$(git-commit) ${entry.shortHash}`,
        description: `${entry.subject}${refs}`,
        commitRef: entry.hash
      })
    }
  } catch (e) { /* git log failed */ }

  return new Promise(resolve => {
    let resolved = false
    const qp = vscode.window.createQuickPick()
    qp.items = items
    qp.placeholder = prompt
    qp.matchOnDescription = true

    qp.onDidAccept(() => {
      if (resolved) return
      const active = qp.activeItems[0]
      if (active) {
        resolved = true
        qp.dispose()
        resolve(active.commitRef)
      } else if (qp.value.trim()) {
        resolved = true
        qp.dispose()
        resolve(qp.value.trim())
      }
    })

    qp.onDidHide(() => {
      qp.dispose()
      if (!resolved) resolve(null)
    })

    qp.show()
  })
}

/**
 * Collects markdown and ASN.1 files from the given URIs.
 * @param {vscode.Uri[]} uris - Array of file or folder URIs.
 * @returns {string[]} Sorted array of absolute file paths.
 */
function collectFilesFromUris(uris) {
  return collectFiles(uris.map(u => u.fsPath))
}

/**
 * Collects files from a git commit, mapping VSCode URIs to paths.
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {vscode.Uri[]} uris - Array of file or folder URIs.
 * @param {string} commit - Git commit reference.
 * @returns {string[]} Sorted array of absolute file paths.
 */
function collectFilesFromCommitUris(repoRoot, uris, commit) {
  return collectFilesFromCommit(repoRoot, uris.map(u => u.fsPath), commit)
}

/**
 * Creates a mermaid renderer function that uses a hidden VS Code webview
 * with content-addressed SVG caching in the spec root.
 * @param {string} mermaidConfig - Mermaid config JSON string.
 * @param {string} mermaidBundlePath - Absolute path to the cached mermaid.min.js.
 * @param {string} specRoot - Absolute path to the specification root.
 * @returns {Function} Async function `(codes) => svgs[]`.
 */
function makeMermaidRenderer(mermaidConfig, mermaidBundlePath, specRoot) {
  const { renderWithCache, renderMermaidViaWebview } = require('specpress/lib/md2docx/handlers/mermaidHandler')
  return (codes) => renderWithCache(
    codes, mermaidConfig, specRoot,
    (uncachedCodes) => renderMermaidViaWebview(vscode, uncachedCodes, mermaidConfig, mermaidBundlePath)
  )
}

/**
 * Generates a filename from CR cover page data.
 * Format: YYYY-MM-DD_HH-MM-SS_R{release}-{spec}_CR{number}[r{rev}]_{title}.docx
 * Example: 2024-03-15_14-30-45_R19-38.413_CR1234r2_Correction_to_handover.docx
 * 
 * The date/time is the current UTC time, not from the CR data.
 * The revision suffix (r{rev}) is only included if rev > 0.
 * 
 * @param {object} crData - CR cover page data with Release, Specification, CR, rev, Title
 * @returns {string|null} - Generated filename or null if data is incomplete
 */
function generateCRFilename(crData) {
  if (!crData) return null
  
  try {
    // Extract fields
    const release = crData.Release || null
    const spec = crData.Specification || null
    const crNumber = crData.CR || null
    const rev = crData.rev || 0
    const title = crData.Title || null
    
    // Validate required fields (Release, Specification, CR, Title must be present and non-zero)
    if (!release || !spec || !crNumber || !title) return null
    if (typeof title !== 'string' || title.trim() === '') return null
    
    // Generate current timestamp (YYYY-MM-DD_HH-MM-SS)
    const timestamp = formatExportTimestamp().replace(/ /g, '_')
    
    // Format release-spec (e.g., R19-38.413)
    const releaseSpec = `R${release}-${spec}`
    
    // Format CR number with leading zeros (e.g., 0123)
    const crFormatted = crNumber.toString().padStart(4, '0')
    
    // Format revision (e.g., r2, or empty for rev 0 or undefined)
    const revFormatted = (rev && rev > 0) ? `r${rev}` : ''
    
    // Sanitize title for filename (replace invalid chars with underscore)
    const titleSanitized = title
      .replace(/[<>:"/\\|?*]/g, '_')  // Replace invalid filename chars
      .replace(/\s+/g, '_')            // Replace spaces with underscore
      .replace(/_+/g, '_')             // Collapse multiple underscores
      .replace(/^_|_$/g, '')           // Trim leading/trailing underscores
      .substring(0, 50)                // Limit length
    
    // Build filename: YYYY-MM-DD_HH-MM-SS_R{release}-{spec}_CR{number}[r{rev}]_{title}.docx
    const filename = `${timestamp}_${releaseSpec}_CR${crFormatted}${revFormatted}_${titleSanitized}.docx`
    
    return filename
  } catch (e) {
    return null
  }
}

module.exports = {
  NOT_CONFIGURED_MSG,
  formatExportTimestamp,
  showExportNotification,
  pickCommit,
  collectFilesFromUris,
  collectFilesFromCommitUris,
  extractFilesFromCommit,
  insertOmittedMarkers,
  makeMermaidRenderer,
  findWinword,
  generateCRFilename
}
