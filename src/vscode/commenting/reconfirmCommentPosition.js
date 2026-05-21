const vscode = require('vscode')
const path = require('path')
const fs = require('fs')

/**
 * Command to reconfirm a comment's position at the current cursor location.
 * Useful after making changes to address a comment.
 */
async function reconfirmCommentPosition(commentManager, decorationManager, codeLensProvider, config) {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showErrorMessage('No active editor')
    return
  }

  const filePath = editor.document.uri.fsPath
  if (!config.isInsideSpecRoot(filePath)) {
    vscode.window.showErrorMessage('File is not inside a specification root')
    return
  }

  const specRoot = config.getSpecRootForFile(filePath)
  const relativeUri = path.relative(specRoot, filePath).replace(/\\/g, '/')

  // Get all comments for this file
  const allComments = await commentManager.findCommentsForFile(relativeUri, specRoot)
  
  if (allComments.length === 0) {
    vscode.window.showErrorMessage('No comments found in this file')
    return
  }

  // Filter to parent comments only (not replies)
  const parentComments = allComments.filter(c => !c.replyTo)
  
  if (parentComments.length === 0) {
    vscode.window.showErrorMessage('No parent comments found in this file')
    return
  }

  // Show quick pick to select comment
  const items = parentComments.map(c => {
    let label = `Line ${c.lineNumber + 1}: ${c.commentText.substring(0, 60)}`
    if (c.commentText.length > 60) label += '...'
    
    const status = c.resolved ? '✅' : '❗'
    
    return {
      label: `${status} ${label}`,
      description: `by ${c.authorName}`,
      comment: c
    }
  })

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select comment to reconfirm at current cursor position',
    title: 'Reconfirm Comment Position'
  })

  if (!selected) return

  const comment = selected.comment
  const userId = config.userId

  // Warn if reconfirming another author's comment
  if (comment.authorId !== userId) {
    const confirm = await vscode.window.showWarningMessage(
      `Reconfirm position for comment by ${comment.authorName}?`,
      { modal: true, detail: 'This will update the comment\'s position to your current cursor location.' },
      'Reconfirm'
    )
    if (confirm !== 'Reconfirm') return
  }

  try {
    // Get current cursor position
    const lineNumber = editor.selection.active.line
    const columnNumber = editor.selection.active.character

    // Extract ±20 characters around cursor position
    const document = editor.document
    const cursorOffset = document.offsetAt(editor.selection.active)
    const startOffset = Math.max(0, cursorOffset - 20)
    const endOffset = Math.min(document.getText().length, cursorOffset + 20)
    const startPos = document.positionAt(startOffset)
    const endPos = document.positionAt(endOffset)
    const snippet = document.getText(new vscode.Range(startPos, endPos))

    // Update comment file
    const commentPath = path.join(commentManager.getCommentFolder(specRoot), comment.commentId)
    const content = JSON.parse(fs.readFileSync(commentPath, 'utf8'))
    
    content.lineNumber = lineNumber
    content.columnNumber = columnNumber
    content.lineSnippet = snippet
    content.updatedAt = new Date().toISOString()
    
    fs.writeFileSync(commentPath, JSON.stringify(content, null, 2))
    commentManager.invalidateCache(specRoot)

    // Refresh UI
    await decorationManager.updateDecorations(editor, config)
    codeLensProvider.refresh()

    vscode.window.showInformationMessage(
      `Comment position updated to Line ${lineNumber + 1}, Column ${columnNumber}`
    )
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to update position: ${e.message}`)
  }
}

module.exports = { reconfirmCommentPosition }
