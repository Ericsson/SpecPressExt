const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { getGitLog } = require('specpress/lib/common/gitHelpers')
const { collectFiles } = require('specpress/lib/common/specProcessor')
const { collectFilesFromCommit } = require('specpress/lib/common/gitHelpers')
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
  const { renderMermaidCached } = require('specpress/lib/common/diagramRenderers')
  const { renderMermaidViaWebview } = require('./mermaidWebviewRenderer')
  return (codes) => renderMermaidCached(
    codes, mermaidConfig, specRoot,
    (uncachedCodes) => renderMermaidViaWebview(uncachedCodes, mermaidConfig, mermaidBundlePath)
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

/**
 * Prompts the user to pick a base version and up to (maxVersions-1) additional versions.
 * Returns a uniform array of version objects: [{ commitInput, shortHash, label, authorName }]
 *
 * - commitInput: commit hash string, '' for local files, or null for local (no git)
 * - shortHash: short hash string or null for local
 * - label: display string ('local' or short hash)
 * - authorName: author string for tracked-changes attribution, or null for base/HTML
 *
 * @param {string} repoRoot
 * @param {string} basePrompt - Prompt for the base version picker.
 * @param {string} comparePrompt - Prompt for the compare version picker(s).
 * @param {number} [maxVersions=2] - Maximum number of versions (1 = no diff possible).
 * @param {boolean} [askAuthors=false] - If true, prompt for author name for each additional version.
 * @returns {Promise<Array|null>} Array of version objects, or null if user cancelled.
 */
async function pickVersions(repoRoot, basePrompt, comparePrompt, maxVersions = 2, askAuthors = false) {
  const vscode = require('vscode')

  const makeVersion = (commitInput, shortHash, authorName = null) => ({
    commitInput,
    shortHash,
    label: shortHash || 'local',
    authorName
  })

  // Step 1: base version
  const basePicked = await pickCommit(repoRoot, basePrompt, { localFilesOption: true })
  if (basePicked === null) return null

  let baseShortHash = null
  if (basePicked) {
    try {
      baseShortHash = execSync(`git rev-parse --short ${basePicked}`, { cwd: repoRoot, encoding: 'utf8' }).trim()
    } catch (e) {
      vscode.window.showErrorMessage(`Invalid commit reference: ${basePicked}`)
      return null
    }
  }

  const versions = [makeVersion(basePicked || null, baseShortHash)]

  // Step 2+: optional additional versions
  while (versions.length < maxVersions) {
    const versionNum = versions.length + 1
    const prompt = versions.length === 1
      ? comparePrompt
      : `${comparePrompt} (version ${versionNum}, or None to finish)`
    const picked = await pickCommit(repoRoot, prompt, { localFilesOption: true, noneOption: true })
    if (picked === null) return null  // Escape = cancel entirely
    if (picked === 'NONE') break

    let shortHash = null
    const commitInput = picked  // '' for local, hash string for commit
    if (picked) {
      try {
        shortHash = execSync(`git rev-parse --short ${picked}`, { cwd: repoRoot, encoding: 'utf8' }).trim()
      } catch (e) {
        vscode.window.showErrorMessage(`Invalid commit reference: ${picked}`)
        return null
      }
    }

    let authorName = null
    if (askAuthors) {
      let defaultAuthor
      if (shortHash) {
        try {
          const msg = execSync(`git log -1 --format=%s ${picked}`, { cwd: repoRoot, encoding: 'utf8' }).trim()
          const msgSanitized = msg.substring(0, 40)
            .replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
          defaultAuthor = `${shortHash}_${msgSanitized}`
        } catch (e) {
          defaultAuthor = `Author${versions.length}`
        }
      } else {
        defaultAuthor = `Author${versions.length}`
      }
      authorName = await vscode.window.showInputBox({
        prompt: `Author name for changes introduced by version ${versionNum} (${shortHash || 'local'})`,
        value: defaultAuthor,
        placeHolder: 'Author name for tracked changes'
      })
      if (!authorName) return null
    }

    versions.push(makeVersion(commitInput || null, shortHash, authorName))
  }

  return versions
}

/**
 * Shows a VS Code warning message if msc-gen is not installed.
 * Called before HTML or DOCX export to inform the user that MSC-Gen diagrams
 * will be skipped. The message includes a link to the installation page.
 */
function warnIfMscgenMissing() {
  const { findMscgen } = require('specpress/lib/common/mscgenRenderer')
  if (!findMscgen()) {
    vscode.window.showWarningMessage(
      'msc-gen not found — MSC-Gen diagrams will not be rendered. ' +
      'See installation instructions.',
      'Install msc-gen'
    ).then(choice => {
      if (choice === 'Install msc-gen') {
        vscode.env.openExternal(vscode.Uri.parse('https://gitlab.com/msc-generator/msc-generator/#download-and-install'))
      }
    })
  }
}

module.exports = {
  NOT_CONFIGURED_MSG,
  formatExportTimestamp,
  showExportNotification,
  pickCommit,
  pickVersions,
  collectFilesFromUris,
  collectFilesFromCommitUris,
  insertOmittedMarkers,
  makeMermaidRenderer,
  warnIfMscgenMissing,
  findWinword,
  generateCRFilename
}
