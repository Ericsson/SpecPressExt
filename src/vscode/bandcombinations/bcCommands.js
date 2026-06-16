async function bcRefresh(bcTreeProvider) {
  bcTreeProvider.refresh()
}

async function openBcPreview(bcPreviewManager, filePath, bcTreeView, state) {
  const vscode = require('vscode')
  const path = require('path')
  
  // Check if auto preview is enabled (default to enabled)
  const autoPreviewEnabled = state.bcAutoPreviewEnabled !== undefined ? state.bcAutoPreviewEnabled : true
  
  if (autoPreviewEnabled) {
    // Open both JSON editor + HTML preview
    await bcPreviewManager.openPreview(filePath)
    
    // Refocus the Band Combinations tree view to allow keyboard navigation
    if (bcTreeView) {
      await vscode.commands.executeCommand('specpressBcTree.focus')
    }
  } else {
    // Only open JSON editor
    const doc = await vscode.workspace.openTextDocument(filePath)
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One)
  }
}

async function configureBcFolder() {
  const vscode = require('vscode')
  // Open workspace settings JSON
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  if (workspaceFolder) {
    const settingsPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'settings.json')
    try {
      await vscode.workspace.fs.stat(settingsPath)
      await vscode.window.showTextDocument(settingsPath)
    } catch (e) {
      // File doesn't exist, open settings UI instead
      vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', 'specpress.bandCombinationFolder')
    }
  } else {
    vscode.commands.executeCommand('workbench.action.openSettings', 'specpress.bandCombinationFolder')
  }
}

async function bcNormalize() {
  const vscode = require('vscode')
  const fs = require('fs')
  const path = require('path')
  
  // Get active editor
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage('No file is currently open')
    return
  }
  
  const filePath = editor.document.uri.fsPath
  
  // Check if it's a JSON file
  if (!filePath.endsWith('.json')) {
    vscode.window.showWarningMessage('Current file is not a JSON file')
    return
  }
  
  // Check if it's a BC file (CA_*.json or DC_*.json)
  const fileName = path.basename(filePath)
  if (!fileName.startsWith('CA_') && !fileName.startsWith('DC_')) {
    vscode.window.showWarningMessage('Current file is not a Band Combination file (must start with CA_ or DC_)')
    return
  }
  
  // Save the file first
  if (editor.document.isDirty) {
    await editor.document.save()
  }
  
  try {
    // Load and normalize using jsvalidator library function
    const { normalizeBC } = await import('ran4-jsvalidator/src/NormalizeBC.js')
    
    const absPath = normalizeBC(filePath)
    
    // Reload the file in the editor to show normalized content
    const document = await vscode.workspace.openTextDocument(filePath)
    await vscode.window.showTextDocument(document, editor.viewColumn)
    
    vscode.window.showInformationMessage(`Normalized: ${fileName}`)
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to normalize: ${e.message}`)
  }
}

async function bcPreviewFiltered(bcTreeProvider, bcPreviewManager) {
  const vscode = require('vscode')
  
  const filteredFiles = bcTreeProvider.getFilteredFiles()
  
  if (filteredFiles.length === 0) {
    vscode.window.showInformationMessage('No band combinations match the current filter')
    return
  }
  
  const limitedFiles = filteredFiles.slice(0, 100)
  
  if (filteredFiles.length > 100) {
    vscode.window.showInformationMessage(`Preview limited to first 100 entries (${filteredFiles.length} total)`)
  }
  
  await bcPreviewManager.openMultiPreview(limitedFiles)
}

async function bcExportGitDiff(config) {
  const vscode = require('vscode')
  const path = require('path')
  const fs = require('fs')
  const { execSync } = require('child_process')
  
  const bcFolder = config.raw.get('bandCombinationFolder', '')
  if (!bcFolder) {
    vscode.window.showWarningMessage('bandCombinationFolder is not configured')
    return
  }
  
  const absFolder = path.isAbsolute(bcFolder) 
    ? bcFolder 
    : config.wsRoot ? path.join(config.wsRoot, bcFolder) : bcFolder
  
  if (!fs.existsSync(absFolder)) {
    vscode.window.showErrorMessage(`bandCombinationFolder does not exist: ${absFolder}`)
    return
  }
  
  // Find all git repos under BC folder
  const gitRepos = findGitRepos(absFolder)
  
  if (gitRepos.length === 0) {
    vscode.window.showErrorMessage('No git repositories found in the band combination folder')
    return
  }
  
  // Step 1: Select repository
  let selectedRepo
  if (gitRepos.length === 1) {
    selectedRepo = gitRepos[0]
  } else {
    const repoOptions = gitRepos.map(repo => ({
      label: path.basename(repo),
      description: repo,
      repo: repo
    }))
    
    const repoPick = await vscode.window.showQuickPick(repoOptions, {
      placeHolder: 'Select git repository',
      title: 'Export Git Diff'
    })
    
    if (!repoPick) return
    selectedRepo = repoPick.repo
  }
  
  // Step 2: Select "from" commit
  const fromCommit = await pickCommitForDiff(selectedRepo, 'Select FROM version')
  if (!fromCommit) return
  
  // Step 3: Select "to" commit (with "Local files" option)
  const toCommit = await pickCommitForDiff(selectedRepo, 'Select TO version', true)
  if (toCommit === null) return
  
  // Step 4: Generate diff
  try {
    let diffOutput
    if (toCommit === '') {
      // Diff against local files
      diffOutput = execSync(`git diff ${fromCommit}`, {
        cwd: selectedRepo,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
      })
    } else {
      // Diff between two commits
      diffOutput = execSync(`git diff ${fromCommit} ${toCommit}`, {
        cwd: selectedRepo,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024
      })
    }
    
    if (!diffOutput.trim()) {
      vscode.window.showInformationMessage('No differences found between selected versions')
      return
    }
    
    // Step 5: Save to file
    const defaultExportFolder = config.raw.get('defaultExportFolder', 'export')
    const exportFolder = path.isAbsolute(defaultExportFolder)
      ? defaultExportFolder
      : config.wsRoot ? path.join(config.wsRoot, defaultExportFolder) : defaultExportFolder
    
    if (!fs.existsSync(exportFolder)) {
      fs.mkdirSync(exportFolder, { recursive: true })
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19).replace('T', ' ')
    const fromShort = fromCommit.substring(0, 7)
    const toShort = toCommit ? toCommit.substring(0, 7) : 'local'
    const repoName = path.basename(selectedRepo)
    const defaultName = `${timestamp} ${repoName}_${fromShort}_to_${toShort}.diff`
    
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(exportFolder, defaultName)),
      filters: { 'Diff files': ['diff', 'patch'] }
    })
    
    if (!saveUri) return
    
    fs.writeFileSync(saveUri.fsPath, diffOutput, 'utf8')
    
    const action = await vscode.window.showInformationMessage(
      `Git diff exported: ${path.basename(saveUri.fsPath)}`,
      'Open Diff'
    )
    
    if (action === 'Open Diff') {
      const doc = await vscode.workspace.openTextDocument(saveUri.fsPath)
      await vscode.window.showTextDocument(doc)
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to generate diff: ${e.message}`)
  }
}

function findGitRepos(rootPath) {
  const fs = require('fs')
  const path = require('path')
  const repos = []
  
  const scanDir = (dir, depth = 0) => {
    if (depth > 3) return
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      
      if (entries.some(e => e.isDirectory() && e.name === '.git')) {
        repos.push(dir)
        return
      }
      
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
          scanDir(path.join(dir, entry.name), depth + 1)
        }
      }
    } catch (e) {
      // Skip inaccessible directories
    }
  }
  
  scanDir(rootPath)
  return repos
}

async function pickCommitForDiff(repoRoot, title, includeLocalOption = false) {
  const vscode = require('vscode')
  const { execSync } = require('child_process')
  
  try {
    const logOutput = execSync(
      'git log --all --pretty=format:"%H|%h|%an|%ar|%s" -n 200',
      { cwd: repoRoot, encoding: 'utf8' }
    )
    
    const commits = logOutput.split('\n').filter(line => line.trim()).map(line => {
      const [hash, shortHash, author, date, message] = line.split('|')
      return {
        label: message || '(no message)',
        description: `${shortHash} • ${author} • ${date}`,
        detail: hash,
        hash: hash
      }
    })
    
    if (includeLocalOption) {
      commits.unshift({
        label: 'Local files (current workspace)',
        description: 'Compare against uncommitted changes',
        detail: '',
        hash: ''
      })
    }
    
    const picked = await vscode.window.showQuickPick(commits, {
      placeHolder: 'Type to search by message, hash, or author',
      title: title,
      matchOnDescription: true,
      matchOnDetail: true
    })
    
    if (!picked) return null
    return picked.hash
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to get git log: ${e.message}`)
    return null
  }
}

async function bcTogglePreview(state) {
  const vscode = require('vscode')
  
  // Get current state from extension state (default to true)
  const currentState = state.bcAutoPreviewEnabled !== undefined ? state.bcAutoPreviewEnabled : true
  const newState = !currentState
  
  // Store in state manager
  state.bcAutoPreviewEnabled = newState
  
  // Update context for menu icon
  await vscode.commands.executeCommand('setContext', 'specpress.bcAutoPreviewEnabled', newState)
  
  if (newState) {
    vscode.window.showInformationMessage('Band Combination auto preview enabled')
  } else {
    vscode.window.showInformationMessage('Band Combination auto preview disabled')
  }
}

module.exports = { bcRefresh, openBcPreview, configureBcFolder, bcNormalize, bcPreviewFiltered, bcExportGitDiff, bcTogglePreview }
