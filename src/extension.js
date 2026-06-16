const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { ConfigLoader } = require('./vscode/configLoader')
const { StateManager } = require('./vscode/stateManager')
const { PreviewManager } = require('./vscode/previewManager')
const { exportHtml } = require('./vscode/exportHtml')
const { exportDocx } = require('./vscode/exportDocx')
const { compareDocx } = require('./vscode/compareDocx')
const { NOT_CONFIGURED_MSG, pickCommit, extractFilesFromCommit } = require('./vscode/helpers')
const { getRepoRoot } = require('specpress/lib/common/gitHelpers')
const { JsonTableEditorProvider } = require('./vscode/jsonTableEditor')
const { CommentManager } = require('./vscode/commenting/commentManager')
const { CommentDecorationManager } = require('./vscode/commenting/commentDecorations')
const { CommentHoverProvider } = require('./vscode/commenting/commentHoverProvider')
const { CommentTreeProvider } = require('./vscode/commenting/commentTreeProvider')
const { CommentDetailViewProvider } = require('./vscode/commenting/commentDetailViewProvider')
const { CommentFilterViewProvider } = require('./vscode/commenting/commentFilterViewProvider')
const { addComment } = require('./vscode/commenting/addComment')
const { handleCommentClick } = require('./vscode/commenting/handleCommentClick')
const { validateCommentPositions } = require('./vscode/commenting/validateCommentPositions')
const { selectCommentInTree, showCommentInSidebar } = require('./vscode/commenting/commentHelpers')
const { extractSnippet } = require('./vscode/commenting/snippetExtractor')
const { logger } = require('./vscode/logger')
const { BcTreeProvider } = require('./vscode/bandcombinations/bcTreeProvider')
const { BcFilterViewProvider } = require('./vscode/bandcombinations/bcFilterViewProvider')
const { BcValidationViewProvider } = require('./vscode/bandcombinations/bcValidationViewProvider')
const { BcPreviewManager } = require('./vscode/bandcombinations/bcPreviewManager')
const { bcRefresh, openBcPreview, configureBcFolder, bcNormalize, bcPreviewFiltered, bcExportGitDiff, bcTogglePreview } = require('./vscode/bandcombinations/bcCommands')

const config = new ConfigLoader()
const state = new StateManager()

/** @type {PreviewManager|null} */
let previewMgr = null

/** @type {CommentManager|null} */
let commentMgr = null

/** @type {CommentDecorationManager|null} */
let decorationMgr = null


/** @type {CommentTreeProvider|null} */
let commentTreeProvider = null

/** @type {CommentDetailViewProvider|null} */
let commentDetailViewProvider = null

/** @type {CommentFilterViewProvider|null} */
let commentFilterViewProvider = null

/** @type {BcTreeProvider|null} */
let bcTreeProvider = null

/** @type {BcFilterViewProvider|null} */
let bcFilterViewProvider = null

/** @type {BcValidationViewProvider|null} */
let bcValidationViewProvider = null

/** @type {BcPreviewManager|null} */
let bcPreviewManager = null

/**
 * Activates the extension. Registers all commands and listeners.
 *
 * @param {vscode.ExtensionContext} context - The extension context provided by VSCode.
 */
function activate(context) {
  const extensionDir = path.join(__dirname, '..')
  previewMgr = new PreviewManager(state, config, extensionDir)

  // Initialize logger based on configuration or environment variable
  const enableLogging = process.env.VSCODE_SPECPRESS_DEBUG === 'true' || config.raw.get('enableDebugLogging', false)
  logger.setEnabled(enableLogging)

  // Initialize comment system
  commentMgr = new CommentManager(config)
  commentMgr.startWatching()
  decorationMgr = new CommentDecorationManager(commentMgr, extensionDir)
  commentTreeProvider = new CommentTreeProvider(commentMgr, config)
  commentDetailViewProvider = new CommentDetailViewProvider(commentMgr, config, extensionDir)
  commentFilterViewProvider = new CommentFilterViewProvider(commentTreeProvider)
  
  // Connect tree provider to detail view provider for bold styling
  commentDetailViewProvider.setTreeProvider(commentTreeProvider)

  // Subscribe views to CommentManager changes
  context.subscriptions.push(
    commentMgr.onDidChange(() => {
      // Clear and refresh decorations for active editor
      const editor = vscode.window.activeTextEditor
      if (editor) {
        decorationMgr.clear()
        decorationMgr.updateDecorations(editor, config)
      }
      
      // Refresh tree view
      commentTreeProvider.refresh()
      
      // Refresh detail view if showing a comment
      if (commentDetailViewProvider.currentComment && commentDetailViewProvider.currentSpecRoot) {
        commentDetailViewProvider.updateView()
      }
    })
  )
  context.subscriptions.push(commentMgr)

  // Register tree view for comments
  const treeView = vscode.window.createTreeView('specpressComments', {
    treeDataProvider: commentTreeProvider,
    showCollapseAll: true,
    canSelectMany: false
  })
  context.subscriptions.push(treeView)

  // Listen to selection changes to prevent unwanted collapses
  context.subscriptions.push(
    treeView.onDidChangeSelection(e => {
      logger.log('Tree selection changed', { selectionCount: e.selection.length })
      if (e.selection.length > 0) {
        const selected = e.selection[0]
        if (selected && selected.comment) {
          logger.log('Selected comment', { 
            commentId: selected.comment.commentId, 
            isReply: !!selected.comment.replyTo,
            suppressRefresh: commentTreeProvider.suppressRefresh
          })
          
          // Update the selected comment indicator WITHOUT refreshing
          commentTreeProvider.setSelectedComment(selected.comment.commentId, false)
          
          // Show in detail view
          const specRoot = selected.specRoot || selected.comment.specRoot
          if (specRoot) {
            commentDetailViewProvider.showComment(selected.comment, specRoot)
          }
        }
      }
    })
  )

  // Register filter view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'specpressCommentFilter',
      commentFilterViewProvider
    )
  )

  // Register webview for comment details in sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'specpressCommentDetail',
      commentDetailViewProvider
    )
  )

  // Register hover provider for comment tooltips
  const hoverProvider = new CommentHoverProvider(commentMgr, config)
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: 'markdown' }, { pattern: '**/*.asn' }],
      hoverProvider
    )
  )

  // Update decorations when editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (editor) {
        decorationMgr.clear()
        await decorationMgr.updateDecorations(editor, config)
      }
    })
  )

  // Update decorations when document is saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async doc => {
      const editor = vscode.window.activeTextEditor
      if (editor && editor.document === doc) {
        const filePath = doc.uri.fsPath
        if (config.isInsideSpecRoot(filePath)) {
          const specRoot = config.getSpecRootForFile(filePath)
          
          // Auto-update comment positions if safe (fires onDidChange if updates occur)
          const result = await commentMgr.autoUpdateOnSave(doc, specRoot)
          
          if (result.count > 0) {
            const details = result.details.join(', ')
            vscode.window.showInformationMessage(
              `Auto-updated ${result.count} comment position(s): ${details}`,
              'OK'
            )
          }
        }
        
        // Update decorations and tree (onDidChange already handled this if auto-update occurred)
        decorationMgr.clear()
        await decorationMgr.updateDecorations(editor, config)
        commentTreeProvider.refresh()
      }
    })
  )

  // Update decorations and tree when document content changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async e => {
      const editor = vscode.window.activeTextEditor
      if (editor && editor.document === e.document) {
        await decorationMgr.updateDecorations(editor, config)
        // Refresh tree to update moved status icons
        commentTreeProvider.refresh()
      }
    })
  )

  // Initial decoration for active editor
  if (vscode.window.activeTextEditor) {
    decorationMgr.clear()
    decorationMgr.updateDecorations(vscode.window.activeTextEditor, config)
  }

  context.subscriptions.push(decorationMgr)

  // Register JsonTable custom editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      JsonTableEditorProvider.viewType,
      new JsonTableEditorProvider(context),
      { supportsMultipleEditorsPerDocument: false }
    )
  )

  // Initialize Band Combination pane (always visible, shows config hint if not configured)
  bcPreviewManager = new BcPreviewManager(state, config)
  bcTreeProvider = new BcTreeProvider(config, bcPreviewManager)
  bcFilterViewProvider = new BcFilterViewProvider(bcTreeProvider)
  bcValidationViewProvider = new BcValidationViewProvider(config)

  // Initialize auto preview state (default to enabled)
  state.bcAutoPreviewEnabled = true
  vscode.commands.executeCommand('setContext', 'specpress.bcAutoPreviewEnabled', true)

  // Register BC tree view
  const bcTreeView = vscode.window.createTreeView('specpressBcTree', {
    treeDataProvider: bcTreeProvider,
    showCollapseAll: false
  })
  bcTreeProvider.treeView = bcTreeView
  context.subscriptions.push(bcTreeView)

  // Register BC filter view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'specpressBcFilter',
      bcFilterViewProvider
    )
  )

  // Register BC validation view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'specpressBcValidation',
      bcValidationViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  )

  // Register BC commands
  context.subscriptions.push(
    vscode.commands.registerCommand('specpress.bcRefresh', () => bcRefresh(bcTreeProvider)),
    vscode.commands.registerCommand('specpress.configureBcFolder', () => configureBcFolder()),
    vscode.commands.registerCommand('specpress.bcNormalize', () => bcNormalize()),
    vscode.commands.registerCommand('specpress.bcPreviewFiltered', () => bcPreviewFiltered(bcTreeProvider, bcPreviewManager)),
    vscode.commands.registerCommand('specpress.bcExportGitDiff', () => bcExportGitDiff(config)),
    vscode.commands.registerCommand('specpress.bcTogglePreview', () => bcTogglePreview(state)),
    vscode.commands.registerCommand('specpress.openBcPreview', (uri) => {
      const filePath = uri ? (uri.fsPath || uri) : null
      if (!filePath) {
        vscode.window.showErrorMessage('No file selected for BC preview')
        return
      }
      openBcPreview(bcPreviewManager, filePath, bcTreeView, state)
    })
  )

  context.subscriptions.push(bcPreviewManager)

  context.subscriptions.push(
    vscode.commands.registerCommand('specpress.preview', () => {
      if (!config.resolveSpecRoots().length) {
        vscode.window.showWarningMessage(NOT_CONFIGURED_MSG)
        return
      }
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showErrorMessage('Open a markdown or ASN.1 file first')
        return
      }
      const isMarkdown = editor.document.languageId === 'markdown'
      const isAsn = editor.document.fileName.endsWith('.asn')
      const isCR = previewMgr.isCRJsonFile(editor.document.uri.fsPath)
      if (!isMarkdown && !isAsn && !isCR) {
        vscode.window.showErrorMessage('Open a markdown or ASN.1 file first')
        return
      }
      if (!isCR && !config.isInsideSpecRoot(editor.document.uri.fsPath)) {
        vscode.window.showWarningMessage('SpecPress: This file is outside the configured specificationRootPath.')
        return
      }
      state.autoPreviewActive = true
      previewMgr.setupPreview(editor)
    }),

    vscode.commands.registerCommand('specpress.previewMultiple', async (uri, allUris, options) => {
      if (!config.resolveSpecRoots().length) {
        vscode.window.showWarningMessage(NOT_CONFIGURED_MSG)
        return
      }
      const uris = allUris || (uri ? [uri] : await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        filters: { 'Markdown': ['md', 'markdown', 'asn'] }
      }))

      if (!uris) return

      let commitRef = null
      if (!options || !options.skipCommitPicker) {
        let repoRoot
        try {
          repoRoot = getRepoRoot(fs.statSync(uris[0].fsPath).isDirectory() ? uris[0].fsPath : path.dirname(uris[0].fsPath))
        } catch (e) { /* not a git repo */ }

        if (repoRoot) {
          const picked = await pickCommit(repoRoot, 'Select version for preview', { localFilesOption: true })
          if (picked === null) return
          if (picked) {
            try {
              const shortHash = execSync(`git rev-parse --short ${picked}`, { cwd: repoRoot, encoding: 'utf8' }).trim()
              commitRef = { repoRoot, commit: picked, shortHash }
            } catch (e) {
              vscode.window.showErrorMessage(`Invalid commit reference: ${picked}`)
              return
            }
          }
        }
      }

      await previewMgr.previewMultiple(uris, commitRef)
      state.autoPreviewActive = true
    }),

    vscode.commands.registerCommand('specpress.exportSelectedAsDocx', async (uri, allUris) => {
      if (!config.resolveSpecRoots().length) {
        vscode.window.showWarningMessage(NOT_CONFIGURED_MSG)
        return
      }
      const uris = allUris || (uri ? [uri] : await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        filters: { 'Markdown': ['md', 'markdown', 'asn'] }
      }))
      if (!uris) return

      await exportDocx(state, config, context, uri, uris)
    }),

    vscode.commands.registerCommand('specpress.compareDocx', async (uri, allUris) => {
      if (!config.resolveSpecRoots().length) {
        vscode.window.showWarningMessage(NOT_CONFIGURED_MSG)
        return
      }
      await compareDocx(state, config, context, uri, allUris)
    }),

    vscode.commands.registerCommand('specpress.exportHtml', async () => {
      await exportHtml(state, config, previewMgr)
    }),

    vscode.commands.registerCommand('specpress.editSection', () => {
      if (!state.lastContextTarget) return
      const filePath = state.lastContextTarget.file || (state.currentEditor && state.currentEditor.document.uri.fsPath)
      if (!filePath) return
      const line = state.lastContextTarget.line || 0
      vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then(doc => {
        vscode.window.showTextDocument(doc, vscode.ViewColumn.One).then(editor => {
          const pos = new vscode.Position(line, 0)
          editor.selection = new vscode.Selection(pos, pos)
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
          state.autoPreviewActive = true
          previewMgr.setupPreview(editor)
        })
      })
    }),

    vscode.commands.registerCommand('specpress.openJsonTableEditor', async (uri) => {
      await JsonTableEditorProvider.openEditor(vscode, uri)
    }),

    vscode.commands.registerCommand('specpress.openOrCreateJsonTable', async () => {
      await JsonTableEditorProvider.openOrCreate(vscode)
    }),

    vscode.commands.registerCommand('specpress.toggleChangeTracking', async () => {
      let repoRoot
      const specRoots = config.resolveSpecRoots()
      const searchPath = specRoots.length > 0 ? specRoots[0] : (config.wsRoot || '')
      try {
        repoRoot = getRepoRoot(searchPath)
      } catch (e) {
        vscode.window.showErrorMessage('Change tracking requires a git repository.')
        return
      }

      const baselineCommit = await pickCommit(repoRoot, 'Select baseline commit for change tracking')
      if (!baselineCommit) return

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading baseline for change tracking...' },
        async () => {
          const searchPaths = specRoots.length > 0 ? specRoots : [config.wsRoot]
          const baselineCache = extractFilesFromCommit(repoRoot, baselineCommit, searchPaths)

          state.changeTrackingCommit = baselineCommit
          state.changeTrackingRepoRoot = repoRoot
          state.changeTrackingBaseline = baselineCache
          vscode.commands.executeCommand('setContext', 'specpress.changeTrackingActive', true)

          let shortHash
          try { shortHash = execSync(`git rev-parse --short ${baselineCommit}`, { cwd: repoRoot, encoding: 'utf8' }).trim() } catch (e) { shortHash = baselineCommit.substring(0, 7) }
          vscode.window.showInformationMessage(`SpecPress: Change tracking enabled (baseline: ${shortHash}, ${baselineCache.size} files cached).`)
        }
      )

      // Refresh current preview with diff
      if (state.panel && state.currentEditor) {
        previewMgr.setupPreview(state.currentEditor)
      } else if (state.panel && state.lastMultiFileUris) {
        await previewMgr.previewMultiple(state.lastMultiFileUris, null)
      }
    }),

    vscode.commands.registerCommand('specpress.disableChangeTracking', async () => {
      state.changeTrackingCommit = null
      state.changeTrackingRepoRoot = null
      state.changeTrackingBaseline = null
      vscode.commands.executeCommand('setContext', 'specpress.changeTrackingActive', false)
      vscode.window.showInformationMessage('SpecPress: Change tracking disabled.')
      // Refresh current preview without diff
      if (state.panel && state.currentEditor) {
        previewMgr.setupPreview(state.currentEditor)
      } else if (state.panel && state.lastMultiFileUris) {
        await previewMgr.previewMultiple(state.lastMultiFileUris, null)
      }
    }),

    vscode.commands.registerCommand('specpress.restoreMultiPreview', () => {
      let uris = state.lastMultiFileUris
      if (!uris) {
        const defaultPath = config.multiPagePreviewDefaultPath
        if (!defaultPath) {
          vscode.window.showErrorMessage('No previous multi-file preview to restore.')
          return
        }
        const abs = path.isAbsolute(defaultPath) ? defaultPath
          : config.wsRoot ? path.join(config.wsRoot, defaultPath)
          : defaultPath
        uris = [vscode.Uri.file(abs)]
      }
      const editor = vscode.window.activeTextEditor
      if (editor) {
        const visibleLine = editor.visibleRanges[0]?.start.line || 0
        state.restoreScrollTarget = { file: editor.document.uri.fsPath, line: visibleLine }
      }
      vscode.commands.executeCommand('specpress.previewMultiple', uris[0], uris, { skipCommitPicker: true })
    }),

    vscode.commands.registerCommand('specpress.addComment', async () => {
      await addComment(commentMgr, decorationMgr, commentDetailViewProvider, commentTreeProvider, treeView, config)
    }),

    vscode.commands.registerCommand('specpress.validateCommentPositions', async () => {
      await validateCommentPositions(commentMgr, decorationMgr, config)
    }),

    vscode.commands.registerCommand('specpress.setCommentAnchor', async (comment, specRoot) => {
      // If called from detail view with comment object, use it directly
      if (comment && specRoot) {
        const editor = vscode.window.activeTextEditor
        if (!editor) {
          vscode.window.showErrorMessage('No active editor')
          return
        }

        const userId = config.userId
        if (comment.authorId !== userId) {
          const confirm = await vscode.window.showWarningMessage(
            `Set anchor position for comment by ${comment.authorName}?`,
            { modal: true, detail: 'This will update the comment\'s anchor position to your current cursor location.' },
            'Set Anchor'
          )
          if (confirm !== 'Set Anchor') return
        }

        try {
          const oldLine = comment.lineNumber
          const oldCol = comment.columnNumber !== undefined ? comment.columnNumber : 0
          const lineNumber = editor.selection.active.line
          const columnNumber = editor.selection.active.character
          
          // Show confirmation with old and new positions
          const oldSnippet = (comment.lineSnippet || '').substring(0, 40).replace(/[\r\n]/g, '↵')
          const confirm = await vscode.window.showInformationMessage(
            `Move comment "${oldSnippet}${comment.lineSnippet && comment.lineSnippet.length > 40 ? '...' : ''}" from Line ${oldLine + 1}, Col ${oldCol} to Line ${lineNumber + 1}, Col ${columnNumber}?`,
            { modal: true },
            'Move'
          )
          if (confirm !== 'Move') return
          
          // Extract snippet using centralized function
          const snippet = extractSnippet(editor.document, editor.selection.active)

          const commentPath = path.join(commentMgr.getCommentFolder(specRoot), comment.commentId)
          const content = JSON.parse(fs.readFileSync(commentPath, 'utf8'))
          
          content.lineNumber = lineNumber
          content.columnNumber = columnNumber
          content.lineSnippet = snippet
          content.updatedAt = new Date().toISOString()
          
          fs.writeFileSync(commentPath, JSON.stringify(content, null, 2))
          commentMgr.invalidateCache(specRoot)

          await decorationMgr.updateDecorations(editor, config)

          // Refresh detail view
          const updatedComment = commentMgr.getAllComments(specRoot).find(c => c.commentId === comment.commentId)
          if (updatedComment) {
            commentDetailViewProvider.showComment(updatedComment, specRoot)
          }

          vscode.window.showInformationMessage(
            `Comment anchor moved to Line ${lineNumber + 1}, Column ${columnNumber}`
          )
        } catch (e) {
          vscode.window.showErrorMessage(`Failed to update position: ${e.message}`)
        }
      } else {
        // Called from command palette - show picker
        await reconfirmCommentPosition(commentMgr, decorationMgr, config)
      }
    }),

    // Legacy command name for backward compatibility
    vscode.commands.registerCommand('specpress.reconfirmCommentPosition', async (comment, specRoot) => {
      vscode.window.showWarningMessage('This command has been removed. Use "Set Anchor Position" button in the comment detail view or "Validate Comment Positions" for batch updates.')
    }),

    vscode.commands.registerCommand('specpress.handleCommentClick', async (uri, lineNum) => {
      await handleCommentClick(commentDetailViewProvider, commentTreeProvider, treeView, uri, lineNum)
    }),

    vscode.commands.registerCommand('specpress.refreshCommentTree', () => {
      commentTreeProvider.refresh()
      const editor = vscode.window.activeTextEditor
      if (editor) decorationMgr.updateDecorations(editor, config)
    }),

    vscode.commands.registerCommand('specpress.expandAllComments', async () => {
      const fileItems = await commentTreeProvider.getFileItems()
      for (const fileItem of fileItems) {
        await treeView.reveal(fileItem, { expand: true })
      }
    }),

    vscode.commands.registerCommand('specpress.expandCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return

      const filePath = editor.document.uri.fsPath
      if (!config.isInsideSpecRoot(filePath)) return

      const specRoot = config.getSpecRootForFile(filePath)
      const relativeUri = path.relative(specRoot, filePath).replace(/\\/g, '/')

      const fileItems = await commentTreeProvider.getFileItems()
      
      // Collapse all items first
      for (const fileItem of fileItems) {
        try {
          await treeView.reveal(fileItem, { expand: false })
        } catch (e) {
          // Ignore errors
        }
      }

      // Small delay to ensure collapse completes
      await new Promise(resolve => setTimeout(resolve, 100))

      // Then expand only the current file (without expanding child comments)
      for (const fileItem of fileItems) {
        if (fileItem.comment.fileUri === relativeUri && fileItem.comment.specRoot === specRoot) {
          await treeView.reveal(fileItem, { expand: 1, select: true })
          break
        }
      }
    }),

    vscode.commands.registerCommand('specpress.jumpToComment', async (comment, specRoot) => {
      const filePath = path.isAbsolute(comment.fileUri)
        ? comment.fileUri
        : path.join(specRoot, comment.fileUri)

      try {
        const doc = await vscode.workspace.openTextDocument(filePath)
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One)
        const col = comment.columnNumber !== undefined ? comment.columnNumber : 0
        const pos = new vscode.Position(comment.lineNumber, col)
        editor.selection = new vscode.Selection(pos, pos)
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)

        // Show comment details in sidebar
        commentDetailViewProvider.showComment(comment, specRoot)
        
        // Select in tree (which will handle expansion)
        await selectCommentInTree(commentTreeProvider, treeView, comment, specRoot)
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to open file: ${e.message}`)
      }
    }),

    vscode.commands.registerCommand('specpress.showCommentFromHover', async (commentId, specRoot) => {
      // Find the comment by ID
      const commentFolder = commentMgr.getCommentFolder(specRoot)
      const commentPath = path.join(commentFolder, commentId)
      
      if (!fs.existsSync(commentPath)) {
        vscode.window.showErrorMessage('Comment not found')
        return
      }

      try {
        const content = fs.readFileSync(commentPath, 'utf8')
        const comment = JSON.parse(content)

        // Show in sidebar and select in tree
        await showCommentInSidebar(comment, specRoot, commentDetailViewProvider, commentTreeProvider, treeView)
      } catch (e) {
        vscode.window.showErrorMessage(`Failed to load comment: ${e.message}`)
      }
    }),

    vscode.commands.registerCommand('specpress.showDebugLog', async () => {
      const logPath = logger.getLogPath()
      vscode.window.showInformationMessage(`Debug log: ${logPath}`, 'Open Log', 'Copy Path').then(choice => {
        if (choice === 'Open Log') {
          vscode.workspace.openTextDocument(logPath).then(doc => {
            vscode.window.showTextDocument(doc)
          })
        } else if (choice === 'Copy Path') {
          vscode.env.clipboard.writeText(logPath)
          vscode.window.showInformationMessage('Log path copied to clipboard')
        }
      })
    })
  )

  /**
   * Find and select a comment in the tree view
   */
  async function selectCommentInTree(treeProvider, treeView, comment, specRoot) {
    logger.log('=== selectCommentInTree START ===', { 
      commentId: comment.commentId, 
      isReply: !!comment.replyTo,
      replyTo: comment.replyTo
    })
    
    // Suppress refresh during programmatic selection to preserve expansion state
    treeProvider.suppressRefresh = true
    logger.log('Set suppressRefresh = true')
    
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      logger.log('Initial delay complete')

      const rootItems = await treeProvider.getChildren()
      logger.log('Got root items', { count: rootItems.length })
      
      for (const fileItem of rootItems) {
        if (fileItem.comment.fileUri === comment.fileUri && fileItem.comment.specRoot === specRoot) {
          logger.log('Found matching file item', { fileUri: fileItem.comment.fileUri })
          
          await treeView.reveal(fileItem, { expand: true, select: false, focus: false })
          logger.log('Revealed file item')
          
          await new Promise(resolve => setTimeout(resolve, 50))
          
          const commentItems = await treeProvider.getChildren(fileItem)
          logger.log('Got comment items', { count: commentItems.length })
          
          if (comment.replyTo) {
            logger.log('This is a reply, looking for parent')
            let parentItem = null
            for (const item of commentItems) {
              if (item.comment.commentId === comment.replyTo) {
                parentItem = item
                logger.log('Found parent item', { parentId: comment.replyTo })
                break
              }
            }
            
            if (parentItem) {
              logger.log('Revealing parent with expand=true')
              await treeView.reveal(parentItem, { expand: true, select: false, focus: false })
              logger.log('Parent revealed, waiting 150ms')
              
              await new Promise(resolve => setTimeout(resolve, 150))
              
              const replyItems = await treeProvider.getChildren(parentItem)
              logger.log('Got reply items', { count: replyItems.length })
              
              for (const replyItem of replyItems) {
                if (replyItem.comment.commentId === comment.commentId) {
                  logger.log('Found reply item, revealing with select=true')
                  await treeView.reveal(replyItem, { select: true, focus: true })
                  logger.log('Reply revealed and selected')
                  return
                }
              }
            }
          } else {
            logger.log('This is a parent comment')
            for (const commentItem of commentItems) {
              if (commentItem.comment.commentId === comment.commentId) {
                const hasReplies = treeProvider.hasReplies(comment.commentId, specRoot)
                logger.log('Found comment item', { hasReplies })
                
                if (hasReplies) {
                  logger.log('Comment has replies - expanding with level 3')
                  await treeView.reveal(commentItem, { expand: 3, select: true, focus: true })
                } else {
                  logger.log('Comment has no replies - revealing without expand')
                  await treeView.reveal(commentItem, { expand: false, select: true, focus: true })
                }
                logger.log('Comment revealed and selected')
                return
              }
            }
          }
        }
      }
    } finally {
      logger.log('Waiting 200ms before re-enabling refresh')
      await new Promise(resolve => setTimeout(resolve, 200))
      treeProvider.suppressRefresh = false
      logger.log('Set suppressRefresh = false')
      logger.log('=== selectCommentInTree END ===')
    }
  }

  // Auto preview when switching editors
  let hintShown = false
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor) return
      if (state.autoPreviewActive) {
        if (config.resolveSpecRoots().length) previewMgr.setupPreview(editor)
        return
      }
      if (!hintShown && !state.panel && config.resolveSpecRoots().length) {
        const isSpec = (editor.document.languageId === 'markdown' || editor.document.fileName.endsWith('.asn'))
          && config.isInsideSpecRoot(editor.document.uri.fsPath)
        if (isSpec) {
          hintShown = true
          vscode.window.showInformationMessage(
            'SpecPress: Right-click the file in the explorer and choose "SpecPress: Open Preview" to activate the live preview.',
            'Open Preview'
          ).then(choice => {
            if (choice === 'Open Preview') {
              state.autoPreviewActive = true
              const ed = vscode.window.activeTextEditor
              if (ed) previewMgr.setupPreview(ed)
            }
          })
        }
      }
    })
  )

  // Re-initialize handler when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('specpress')) {
        config.invalidate()
        state.handler = null
        
        // Update logger enabled state
        if (e.affectsConfiguration('specpress.enableDebugLogging')) {
          const enableLogging = config.raw.get('enableDebugLogging', false)
          logger.setEnabled(enableLogging)
        }
        
        // Refresh BC tree if bandCombinationFolder changed
        if (e.affectsConfiguration('specpress.bandCombinationFolder') && bcTreeProvider) {
          bcTreeProvider.refresh()
        }
      }
    })
  )

  // Re-initialize handler when config-referenced files are saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      const wsRoot = config.wsRoot
      if (!wsRoot) return
      const saved = doc.uri.fsPath
      const configFiles = ['cssFile', 'mermaidConfigFile', 'frontPageData', 'coverPageData']
        .map(key => config.raw.get(key, ''))
        .filter(f => f)
        .map(f => path.isAbsolute(f) ? f : path.join(wsRoot, f))
      if (configFiles.some(f => path.resolve(f) === path.resolve(saved))) {
        config.invalidate()
        state.handler = null
      }
    })
  )
}

function deactivate() {}

module.exports = { activate, deactivate }
