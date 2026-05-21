const vscode = require('vscode')
const path = require('path')
const { showCommentInSidebar } = require('./commentHelpers')

/**
 * Handle click on comment indicator - show closest comment in sidebar
 */
async function handleCommentClick(commentDetailViewProvider, commentTreeProvider, treeView, uri, lineNum) {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.toString() !== uri.toString()) return

  // Get cursor column position
  const cursorColumn = editor.selection.active.character

  // Move cursor to the line
  const position = new vscode.Position(lineNum, cursorColumn)
  editor.selection = new vscode.Selection(position, position)

  // Get comments at this position
  const filePath = editor.document.uri.fsPath
  const config = commentDetailViewProvider.config
  const commentManager = commentDetailViewProvider.commentManager
  
  if (!config.isInsideSpecRoot(filePath)) return
  
  const specRoot = config.getSpecRootForFile(filePath)
  const relativeUri = path.relative(specRoot, filePath).replace(/\\/g, '/')
  
  const allComments = await commentManager.findCommentsForFile(relativeUri, specRoot)
  const topLevelComments = allComments
    .filter(c => c.lineNumber === lineNum && !c.replyTo)
    .sort((a, b) => {
      const colA = a.columnNumber !== undefined ? a.columnNumber : 0
      const colB = b.columnNumber !== undefined ? b.columnNumber : 0
      return colA - colB
    })
  
  if (topLevelComments.length === 0) {
    vscode.window.showInformationMessage('No comments at this line')
    return
  }

  // Show first comment in sidebar
  await showCommentInSidebar(topLevelComments[0], specRoot, commentDetailViewProvider, commentTreeProvider, treeView)
}

module.exports = { handleCommentClick }
