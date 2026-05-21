const vscode = require('vscode')
const path = require('path')
const { validateAllCommentsForFile } = require('./commentPositionValidator')

/**
 * Command to validate and fix comment positions in the current file.
 */
async function validateCommentPositions(commentManager, decorationManager, codeLensProvider, config) {
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
  const comments = await commentManager.findCommentsForFile(relativeUri, specRoot)
  
  if (comments.length === 0) {
    vscode.window.showInformationMessage('No comments found in this file')
    return
  }

  // Validate all comments
  const movedComments = await validateAllCommentsForFile(comments, editor.document)

  if (movedComments.length === 0) {
    vscode.window.showInformationMessage('All comments are at their correct positions')
    return
  }

  // Show results and offer to fix
  const message = `Found ${movedComments.length} comment(s) that may have moved. Update their positions?`
  const items = movedComments.map(mc => {
    const c = mc.comment
    const v = mc.validation
    let label = `Line ${c.lineNumber + 1}: ${c.commentText.substring(0, 50)}`
    if (c.commentText.length > 50) label += '...'
    
    let description = ''
    if (v.status === 'moved' && v.suggestedPosition) {
      description = `→ Line ${v.suggestedPosition.line + 1}, Col ${v.suggestedPosition.character}`
    } else if (v.status === 'not-found') {
      description = 'Text not found nearby'
    } else if (v.status === 'line-out-of-range') {
      description = 'Line out of range'
    }
    
    return {
      label,
      description,
      comment: c,
      validation: v
    }
  })

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select comments to update (or press Escape to cancel)',
    title: 'Update Comment Positions'
  })

  if (!selected || selected.length === 0) return

  // Update selected comments
  let updated = 0
  let failed = 0

  for (const item of selected) {
    if (item.validation.status === 'moved' && item.validation.suggestedPosition) {
      try {
        // Update comment position
        const comment = item.comment
        const newPos = item.validation.suggestedPosition
        
        // Read comment file
        const commentPath = path.join(commentManager.getCommentFolder(specRoot), comment.commentId)
        const fs = require('fs')
        const content = JSON.parse(fs.readFileSync(commentPath, 'utf8'))
        
        // Update position and snippet
        content.lineNumber = newPos.line
        content.columnNumber = newPos.character
        
        // Extract new snippet at new position
        const offset = editor.document.offsetAt(newPos)
        const startOffset = Math.max(0, offset - 20)
        const endOffset = Math.min(editor.document.getText().length, offset + 20)
        const startPos = editor.document.positionAt(startOffset)
        const endPos = editor.document.positionAt(endOffset)
        content.lineSnippet = editor.document.getText(new vscode.Range(startPos, endPos))
        
        content.updatedAt = new Date().toISOString()
        
        // Write back
        fs.writeFileSync(commentPath, JSON.stringify(content, null, 2))
        commentManager.invalidateCache(specRoot)
        
        updated++
      } catch (e) {
        console.error(`Failed to update comment ${item.comment.commentId}:`, e)
        failed++
      }
    }
  }

  // Refresh UI
  await decorationManager.updateDecorations(editor, config)
  codeLensProvider.refresh()

  // Show result
  if (failed > 0) {
    vscode.window.showWarningMessage(`Updated ${updated} comment(s), ${failed} failed`)
  } else {
    vscode.window.showInformationMessage(`Updated ${updated} comment position(s)`)
  }
}

module.exports = { validateCommentPositions }
