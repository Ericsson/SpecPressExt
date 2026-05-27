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
 * Detects the path to winword.exe via the Windows registry.
 * Returns the path if found and the file exists, or null otherwise.
 */
function findWinword() {
  if (process.platform !== 'win32') return null
  try {
    const result = require('child_process').execSync(
      'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Winword.exe" /ve',
      { encoding: 'utf8' }
    )
    const match = result.match(/REG_SZ\s+(.+)/)
    const p = match ? match[1].trim() : null
    return (p && require('fs').existsSync(p)) ? p : null
  } catch (e) {
    return null
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
 * Extracts all spec-relevant files from a git commit using git archive + tar parsing.
 * Returns a Map of absolute path to content (Buffer for binary files, string for text).
 *
 * This is used by both the HTML change tracking preview and the DOCX DIFF export
 * to bulk-extract files from a commit in a single process spawn (much faster than
 * individual git show calls per file).
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} commit - Git commit reference.
 * @param {string[]} searchPaths - Absolute paths to directories to extract from.
 * @returns {Map<string, Buffer|string>} Map of absolute file path to content.
 */
function extractFilesFromCommit(repoRoot, commit, searchPaths) {
  const cache = new Map()
  for (const p of searchPaths) {
    const rel = path.relative(repoRoot, p).replace(/\\/g, '/')
    const prefix = rel ? rel + '/' : ''
    try {
      const tar = execSync(`git archive ${commit} -- "${prefix}"`, {
        cwd: repoRoot, maxBuffer: 50 * 1024 * 1024
      })
      let offset = 0
      while (offset < tar.length - 512) {
        const header = tar.slice(offset, offset + 512)
        const name = header.slice(0, 100).toString().replace(/\0/g, '').trim()
        if (!name) break
        const sizeStr = header.slice(124, 136).toString().replace(/\0/g, '').trim()
        const size = parseInt(sizeStr, 8) || 0
        offset += 512
        if (size > 0 && /\.(md|markdown|asn|json|png|jpg|jpeg|gif|bmp|svg)$/.test(name)) {
          const isImage = /\.(png|jpg|jpeg|gif|bmp|svg)$/.test(name)
          const content = isImage
            ? tar.slice(offset, offset + size)
            : tar.slice(offset, offset + size).toString('utf8')
          cache.set(path.join(repoRoot, name), content)
        }
        offset += Math.ceil(size / 512) * 512
      }
    } catch (e) { /* path may not exist in that commit */ }
  }
  return cache
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
 * Inserts OMITTED markers into a concatenated markdown string where gaps exist
 * between selected files (i.e. files from the spec root that were not selected).
 *
 * @param {string} content - Concatenated markdown content (from concatenateFiles).
 * @param {string[]} selectedFiles - Sorted array of selected file paths.
 * @param {string[]} allFiles - Sorted array of all file paths in the spec root.
 * @returns {string} Content with OMITTED markers inserted at gap positions.
 */
function insertOmittedMarkers(content, selectedFiles, allFiles) {
  if (!allFiles || allFiles.length === 0 || selectedFiles.length === allFiles.length) return content
  const norm = (f) => f.replace(/\\/g, '/').toLowerCase()
  const selectedNorm = selectedFiles.map(norm)
  const allNorm = allFiles.map(norm)

  // Find indices of selected files in the full list
  const indices = []
  for (let i = 0; i < allNorm.length; i++) {
    if (selectedNorm.includes(allNorm[i])) indices.push(i)
  }
  if (indices.length === 0) return content

  // Determine which selected files need a marker BEFORE them:
  // - First selected file: if it's not the first file in the spec
  // - Subsequent selected files: if there's a gap before them
  const insertBeforeFiles = []
  if (indices[0] > 0) {
    insertBeforeFiles.push(selectedFiles[0])
  }
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] > 1) {
      insertBeforeFiles.push(selectedFiles[i])
    }
  }
  // Also add trailing marker if last selected file isn't the last in the spec
  const appendMarker = indices[indices.length - 1] < allNorm.length - 1

  if (insertBeforeFiles.length === 0 && !appendMarker) return content

  // Insert markers at gap positions.
  // A file may need markers both before it (inter-folder gap) and after its
  // auto-headings (intra-folder gap) when it's not the first file in its folder
  // AND there are omitted files/folders before it.
  let result = content
  for (let i = insertBeforeFiles.length - 1; i >= 0; i--) {
    const file = insertBeforeFiles[i]
    let fileIdx = result.indexOf('<!-- FILE: ' + file + ' -->')
    if (fileIdx === -1) fileIdx = result.indexOf('<!-- FILE: ' + file.replace(/\\/g, '/') + ' -->')
    if (fileIdx === -1) continue

    // Check if there are auto-headings after the FILE comment
    const afterFile = result.substring(fileIdx)
    const autoRe = /^<!-- FILE: [^\n]+ -->\n((?:<!-- AUTO-HEADING -->\n#+ [^\n]+\n\n)*)/
    const m = afterFile.match(autoRe)
    const hasAutoHeadings = m && m[1].length > 0

    // Determine if there's an intra-folder gap (omitted sibling before this file)
    const fileDir = path.dirname(file).replace(/\\/g, '/').toLowerCase()
    let intraFolderGap = false
    if (hasAutoHeadings) {
      // Check if the immediately preceding file in allFiles is in the same folder
      const fileNorm = norm(file)
      const fileAllIdx = allNorm.indexOf(fileNorm)
      if (fileAllIdx > 0) {
        const prevInAll = allFiles[fileAllIdx - 1]
        const prevDir = path.dirname(prevInAll).replace(/\\/g, '/').toLowerCase()
        if (prevDir === fileDir && !selectedNorm.includes(allNorm[fileAllIdx - 1])) {
          intraFolderGap = true
        }
      }
    }

    // Determine if there's an inter-folder gap (omitted folders/files before this file's folder)
    let interFolderGap = false
    if (hasAutoHeadings) {
      // If this file has auto-headings, check if there are omitted files from OTHER folders before it
      const fileNorm = norm(file)
      const fileAllIdx = allNorm.indexOf(fileNorm)
      for (let j = fileAllIdx - 1; j >= 0; j--) {
        const jDir = path.dirname(allFiles[j]).replace(/\\/g, '/').toLowerCase()
        if (jDir !== fileDir && !selectedNorm.includes(allNorm[j])) {
          interFolderGap = true
          break
        }
        if (jDir !== fileDir) break
      }
    }

    if (hasAutoHeadings && intraFolderGap && interFolderGap) {
      // Need TWO markers: one before FILE comment, one after auto-headings
      const afterAutoPos = fileIdx + m[0].length
      result = result.substring(0, afterAutoPos) + '<!-- OMITTED -->\n\n' + result.substring(afterAutoPos)
      result = result.substring(0, fileIdx) + '<!-- OMITTED -->\n\n' + result.substring(fileIdx)
    } else if (hasAutoHeadings && intraFolderGap) {
      // Only intra-folder gap: marker after auto-headings
      const afterAutoPos = fileIdx + m[0].length
      result = result.substring(0, afterAutoPos) + '<!-- OMITTED -->\n\n' + result.substring(afterAutoPos)
    } else {
      // Inter-folder gap or no auto-headings: marker before FILE comment
      result = result.substring(0, fileIdx) + '<!-- OMITTED -->\n\n' + result.substring(fileIdx)
    }
  }
  if (appendMarker) {
    result = result + '\n<!-- OMITTED -->\n'
  }
  return result
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
  findWinword
}
