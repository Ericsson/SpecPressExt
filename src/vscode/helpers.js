const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getGitLog } = require('specpress/lib/common/gitHelpers')
const { collectFiles } = require('specpress/lib/common/specProcessor')
const { collectFilesFromCommit } = require('specpress/lib/common/gitHelpers')

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
async function showExportNotification(message, folderPath) {
  const choice = await vscode.window.showInformationMessage(message, 'Open Folder')
  if (choice === 'Open Folder') {
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
 * @param {{localFilesOption?: boolean}} [options] - If localFilesOption is true, adds a "Local files" item at the top.
 * @returns {Promise<string|null>} The selected commit reference, empty string for local files, or null if cancelled.
 */
async function pickCommit(repoRoot, prompt, options = {}) {
  const items = []

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

module.exports = {
  NOT_CONFIGURED_MSG,
  formatExportTimestamp,
  showExportNotification,
  pickCommit,
  collectFilesFromUris,
  collectFilesFromCommitUris,
  makeMermaidRenderer
}
