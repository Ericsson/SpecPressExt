const vscode = require('vscode')
const path = require('path')
const { showCommentInSidebar } = require('./commentHelpers')
const { extractSnippet } = require('./snippetExtractor')

/**
 * Command to add a new comment at the current cursor position.
 */
async function addComment(commentManager, decorationManager, commentDetailViewProvider, commentTreeProvider, treeView, config) {
  const editor = vscode.window.activeTextEditor
  if (!editor) return

  const filePath = editor.document.uri.fsPath
  if (!config.isInsideSpecRoot(filePath)) {
    vscode.window.showErrorMessage('File is not inside a specification root')
    return
  }

  // Check if user ID and name are configured
  if (!config.userId || !config.userName) {
    const configure = await vscode.window.showErrorMessage(
      'Please configure specpress.userId and specpress.userName in settings',
      'Open Settings'
    )
    if (configure === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'specpress.user')
    }
    return
  }

  const lineNumber = editor.selection.active.line
  const columnNumber = editor.selection.active.character

  // Extract snippet using centralized function
  const snippet = extractSnippet(editor.document, editor.selection.active)

  // Get spec root to compute relative URI
  const specRoot = config.getSpecRootForFile(filePath)
  const relativeUri = path.relative(specRoot, filePath)

  // Show input box for comment text
  const commentText = await vscode.window.showInputBox({
    prompt: 'Enter your comment',
    placeHolder: 'Type your comment here...',
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return 'Comment text cannot be empty'
      }
      return null
    }
  })

  if (!commentText) return

  try {
    const newComment = await commentManager.createComment(
      relativeUri,
      lineNumber,
      columnNumber,
      snippet,
      commentText,
      specRoot
    )

    vscode.window.showInformationMessage('Comment added')

    // Refresh decorations
    await decorationManager.updateDecorations(editor, config)

    // Show in sidebar and select in tree
    await showCommentInSidebar(newComment, specRoot, commentDetailViewProvider, commentTreeProvider, treeView)
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to add comment: ${e.message}`)
  }
}

module.exports = { addComment }
