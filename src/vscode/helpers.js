const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync, execFileSync } = require('child_process')
const { getGitLog, collectFiles, collectFilesFromCommit, insertOmittedMarkers, findWinword } = require('specpress')

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
 * Returns the current branch name, or null on detached HEAD / failure.
 *
 * Reads `.git/HEAD` directly instead of spawning `git rev-parse` — on most machines a
 * single process spawn costs 200-600ms (process creation / AV scanning overhead, not
 * git's own work), and this function is called on every version picker invocation, so
 * avoiding the spawn matters for responsiveness. `.git/HEAD` is a plain text file with
 * a stable, documented format (`ref: refs/heads/<name>`, or a raw hash when detached)
 * used by git itself and widely relied upon by other tooling. Falls back to the git CLI
 * for worktrees/submodules, where `.git` is a file rather than a directory, or if the
 * file is missing/malformed for any reason.
 * @param {string} repoRoot
 * @returns {string|null}
 */
function getCurrentBranch(repoRoot) {
  try {
    const gitDir = path.join(repoRoot, '.git')
    if (fs.statSync(gitDir).isDirectory()) {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
      const match = head.match(/^ref:\s*refs\/heads\/(.+)$/)
      if (match) return match[1]
      if (/^[0-9a-f]{40}$/i.test(head)) return null // detached HEAD
      // Unexpected format — fall through to the CLI.
    }
  } catch (e) { /* .git/HEAD not readable this way (worktree/submodule) — fall through */ }

  try {
    const name = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    return (name && name !== 'HEAD') ? name : null
  } catch (e) {
    return null
  }
}

/**
 * Returns all local branches (name, tip hash, last-commit date), sorted by most
 * recent commit first. Single git invocation regardless of branch count.
 * @param {string} repoRoot
 * @returns {{name: string, hash: string, date: number}[]}
 */
function getAllBranchesInfo(repoRoot) {
  try {
    const raw = execFileSync(
      'git',
      ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)', 'refs/heads/'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    )
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const [name, hash, date] = line.split('\t')
      return { name, hash, date: parseInt(date, 10) || 0 }
    })
  } catch (e) {
    return []
  }
}

/**
 * Returns {name, hash} for the current branch using a single pre-fetched branch list
 * (see getAllBranchesInfo), avoiding an extra git spawn to resolve HEAD's hash — the
 * current branch's tip is already present in that list.
 * @param {string} repoRoot
 * @param {{name: string, hash: string, date: number}[]} allBranches
 * @returns {{name: string, hash: string}|null}
 */
function getCurrentBranchInfo(repoRoot, allBranches) {
  const name = getCurrentBranch(repoRoot)
  if (!name) return null
  const match = allBranches.find(b => b.name === name)
  return { name, hash: match ? match.hash : name }
}

/**
 * Returns local branch names (excluding the current branch), most-recently-committed first.
 * @param {string} repoRoot
 * @param {string|null} currentBranch
 * @returns {string[]}
 */
function listOtherBranches(repoRoot, currentBranch) {
  return getAllBranchesInfo(repoRoot).map(b => b.name).filter(b => b && b !== currentBranch)
}

// Candidate branches tried for the merge-base ("fork point") heuristic, in order of
// recent activity. Kept tiny (not every branch) because each candidate costs one git
// spawn — process-creation overhead (not git's own work) dominates on most machines, so
// the goal is a small, constant number of spawns regardless of how many branches the
// repository has. The single most-recently-active other branch is overwhelmingly likely
// to be the real parent; the extra candidates are only a fallback for unrelated-history
// branches (where merge-base fails outright).
const PARENT_BRANCH_CANDIDATE_LIMIT = 2

/**
 * Best-effort, low-cost guess at the branch the current branch was created from: tries
 * the most recently active other branches (capped at PARENT_BRANCH_CANDIDATE_LIMIT) and
 * returns the first one for which a merge-base can be computed. This trades a small
 * amount of accuracy (vs. checking every branch and comparing fork-point dates) for a
 * bounded, small number of git spawns — see PARENT_BRANCH_CANDIDATE_LIMIT.
 * @param {string} repoRoot
 * @param {string} currentBranch
 * @param {string[]} candidateBranches - Already sorted by recency (most recent first).
 * @returns {{branch: string, mergeBase: string}|null}
 */
function findParentBranch(repoRoot, currentBranch, candidateBranches) {
  for (const branch of candidateBranches.slice(0, PARENT_BRANCH_CANDIDATE_LIMIT)) {
    try {
      const mergeBase = execFileSync('git', ['merge-base', currentBranch, branch], { cwd: repoRoot, encoding: 'utf8' }).trim()
      if (mergeBase) return { branch, mergeBase }
    } catch (e) { /* unrelated history: merge-base fails — try the next candidate */ }
  }
  return null
}

/**
 * Returns commit log entries for a branch (or range), newest first. Includes ref
 * decorations (other branches/tags also pointing at that commit) so the user can see
 * which commits are shared with other branches while picking one.
 * @param {string} repoRoot
 * @param {string} ref - Branch name, or a range like "base..tip".
 * @param {number} maxCount
 * @returns {{hash: string, shortHash: string, subject: string, refNames: string}[]}
 */
function getBranchLog(repoRoot, ref, maxCount) {
  try {
    const raw = execFileSync(
      'git', ['log', ref, '--format=%H%x09%h%x09%s%x09%D', '-n', String(maxCount)],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    )
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const [hash, shortHash, subject, refNames] = line.split('\t')
      return { hash, shortHash, subject, refNames: refNames || '' }
    })
  } catch (e) {
    return []
  }
}

// Branch name patterns commonly protected in hosted git platforms (GitHub/GitLab/etc).
// There is no local, platform-agnostic way to query actual branch protection rules via
// the git CLI, so this is a naming-convention heuristic used only to prioritize likely
// release/mainline branches in the branch list — it does not affect correctness.
const PROTECTED_BRANCH_PATTERN = /^(main|master|develop|development|release|trunk)$|^release\//i

/** True if a branch name matches a common protected/mainline naming convention. */
function isLikelyProtectedBranch(name) {
  return PROTECTED_BRANCH_PATTERN.test(name)
}

/**
 * Builds the step-1 QuickPick entry set for selecting a git version: quick picks for
 * the current branch's HEAD and its detected fork point, followed by a prioritized list
 * of branches (current, parent, protected-looking, then up to BRANCH_LIST_LIMIT more by
 * recent activity). Selecting a branch item leads to step 2 (picking a specific commit
 * from within that branch) — see pickCommit.
 *
 * Cheap by construction: only a handful of git invocations regardless of repository
 * size (see getCurrentBranchInfo, getAllBranchesInfo, findParentBranch).
 *
 * @param {string} repoRoot
 * @returns {{items: object[], current: {name:string,hash:string}|null, parent: {branch:string,mergeBase:string}|null}}
 */
const BRANCH_LIST_LIMIT = 20
// Max commits shown when the user drills into a single branch (step 2).
const BRANCH_COMMIT_LIMIT = 100

function buildBranchStepItems(repoRoot) {
  const items = []
  const allBranches = getAllBranchesInfo(repoRoot)
  const current = getCurrentBranchInfo(repoRoot, allBranches)

  // No branches at all is unusual (detached HEAD in a repo with no local branches, a
  // bare clone, etc.) — fall back to a flat recent-commits list so the picker still
  // offers something useful.
  if (!current && allBranches.length === 0) {
    try {
      const log = getGitLog(repoRoot, 200)
      log.forEach(entry => {
        const refs = entry.refNames ? ` (${entry.refNames})` : ''
        items.push({
          label: `$(git-commit) ${entry.shortHash}`,
          description: `${entry.subject}${refs}`,
          commitRef: entry.hash
        })
      })
    } catch (e) { /* git log failed */ }
    return { items, current: null, parent: null }
  }

  const otherBranches = allBranches.map(b => b.name).filter(b => current ? b !== current.name : true)
  const parent = current ? findParentBranch(repoRoot, current.name, otherBranches) : null

  if (current) {
    items.push({
      label: `$(git-commit) HEAD of current branch (${current.name})`,
      description: '',
      commitRef: current.hash,
      alwaysShow: true
    })
  }
  if (parent) {
    items.push({
      label: `$(git-branch) BRANCH POINT from branch '${parent.branch}'`,
      description: '',
      commitRef: parent.mergeBase,
      alwaysShow: true
    })
  }

  items.push({ label: 'Branches', kind: vscode.QuickPickItemKind.Separator })

  const branchOrder = []
  const addedBranches = new Set()
  const addBranch = (name) => {
    if (!name || addedBranches.has(name)) return
    addedBranches.add(name)
    branchOrder.push(name)
  }

  if (current) addBranch(current.name)
  if (parent) addBranch(parent.branch)
  allBranches.filter(b => isLikelyProtectedBranch(b.name)).forEach(b => addBranch(b.name))
  allBranches.forEach(b => addBranch(b.name)) // remaining, by recency (already sorted)

  branchOrder.slice(0, BRANCH_LIST_LIMIT).forEach(name => {
    const tags = []
    if (current && name === current.name) tags.push('current')
    if (parent && name === parent.branch) tags.push('BRANCH POINT parent')
    if (isLikelyProtectedBranch(name)) tags.push('protected')
    items.push({
      label: `$(git-branch) ${name}`,
      description: tags.length ? `(${tags.join(', ')})` : '',
      branchRef: name
    })
  })

  return { items, current, parent }
}

/**
 * True if the typed/pasted text plausibly refers to the given QuickPick item (i.e. the
 * user filtered down to it), as opposed to being an unrelated commit hash pasted while
 * an unrelated item (e.g. "Local files", which uses alwaysShow) happens to still be the
 * default-highlighted one.
 * @param {object} item
 * @param {string} typed
 * @returns {boolean}
 */
function matchesTyped(item, typed) {
  const needle = typed.toLowerCase()
  const label = (item.label || '').toLowerCase()
  const description = (item.description || '').toLowerCase()
  return label.includes(needle) || description.includes(needle)
}

/**
 * Shows a vscode.QuickPick built from `items` and resolves with either the typed/pasted
 * text (if present and not just a filter query matching the active item) or the active
 * item itself. Shared by both steps of pickCommit.
 * @param {object[]} items
 * @param {string} prompt
 * @returns {Promise<object|string|null>} The selected item object, the typed string, or
 *   null if cancelled.
 */
function showPickerWithTypedFallback(items, prompt) {
  return new Promise(resolve => {
    let resolved = false
    const qp = vscode.window.createQuickPick()
    qp.items = items
    qp.placeholder = prompt
    qp.matchOnDescription = true

    qp.onDidAccept(() => {
      if (resolved) return
      // Prefer typed/pasted text over the default-highlighted item: pinned
      // (alwaysShow) items stay visible and remain the default active item even
      // while filtering, which otherwise shadows a pasted commit hash that doesn't
      // happen to match anything in the visible list.
      const typed = qp.value.trim()
      const active = qp.activeItems[0]
      if (typed && (!active || !matchesTyped(active, typed))) {
        resolved = true
        qp.dispose()
        resolve(typed)
      } else if (active) {
        resolved = true
        qp.dispose()
        resolve(active)
      } else if (typed) {
        resolved = true
        qp.dispose()
        resolve(typed)
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
 * Shows a two-step QuickPick for selecting a git version:
 *
 * Step 1 offers "Local files"/"None" (if requested), quick picks for the current
 * branch's HEAD and its detected fork point ("BRANCH POINT"), then a prioritized list
 * of branches (current, fork-point parent, protected-looking, then up to
 * BRANCH_LIST_LIMIT more by recent activity). Typing/pasting a commit hash at this
 * step resolves immediately without a second step.
 *
 * Step 2 (only reached by picking a branch item) lists commits within that single
 * branch for the user to pick a specific one from.
 *
 * @param {string} repoRoot - Absolute path to the repository root.
 * @param {string} prompt - Placeholder text for the step-1 QuickPick.
 * @param {{localFilesOption?: boolean, noneOption?: boolean}} [options] - If localFilesOption is true, adds a "Local files" item. If noneOption is true, adds a "None" item at the top.
 * @returns {Promise<string|null>} The selected commit reference, empty string for local files, 'NONE' for none option, or null if cancelled.
 */
async function pickCommit(repoRoot, prompt, options = {}) {
  const pinnedItems = []

  if (options.noneOption) {
    pinnedItems.push({ label: '$(circle-slash) None (finish with current versions)', description: '', commitRef: 'NONE', alwaysShow: true })
  }

  if (options.localFilesOption) {
    pinnedItems.push({ label: '$(file-directory) Local files (current workspace)', description: '', commitRef: '', alwaysShow: true })
  }

  const { items: branchStepItems } = buildBranchStepItems(repoRoot)

  while (true) {
    const picked = await showPickerWithTypedFallback([...pinnedItems, ...branchStepItems], prompt)
    if (picked === null) return null
    if (typeof picked === 'string') return picked // typed/pasted commit ref
    if (picked.commitRef !== undefined) return picked.commitRef // pinned HEAD / BRANCH POINT / Local files / None

    if (picked.branchRef) {
      // Step 2: pick a specific commit from within the chosen branch only.
      const branchLog = getBranchLog(repoRoot, picked.branchRef, BRANCH_COMMIT_LIMIT)
      const commitItems = branchLog.map((entry, i) => {
        // refNames (from %D) lists every ref at this exact commit, including the
        // branch being browsed itself — drop that one so only *other* branches/tags
        // sharing this commit are shown (what the user actually wants to see).
        const otherRefs = entry.refNames
          .split(', ')
          .filter(r => r && r !== picked.branchRef && r !== `HEAD -> ${picked.branchRef}`)
          .join(', ')
        return {
          label: `$(git-commit) ${entry.shortHash}${i === 0 ? ' (latest)' : ''}`,
          description: otherRefs ? `${entry.subject}  [${otherRefs}]` : entry.subject,
          commitRef: entry.hash
        }
      })
      const commitPicked = await showPickerWithTypedFallback(
        commitItems,
        `Select a commit from '${picked.branchRef}'`
      )
      if (commitPicked === null) continue // Escape from step 2 returns to step 1, not full cancel
      if (typeof commitPicked === 'string') return commitPicked
      if (commitPicked.commitRef !== undefined) return commitPicked.commitRef
    }
  }
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
  const { renderMermaidCached } = require('specpress')
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
  const { findMscgen } = require('specpress')
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
  generateCRFilename,
  getCurrentBranch,
  getCurrentBranchInfo,
  listOtherBranches,
  getAllBranchesInfo,
  findParentBranch,
  getBranchLog,
  buildBranchStepItems,
  isLikelyProtectedBranch,
  matchesTyped
}
