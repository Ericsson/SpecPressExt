const vscode = require('vscode')

/**
 * Shared helper functions for comment operations
 */

/**
 * Find and select a comment in the tree view
 */
async function selectCommentInTree(treeProvider, treeView, comment, specRoot) {
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    
    const rootItems = await treeProvider.getChildren()
    
    for (const fileItem of rootItems) {
      if (fileItem.comment.fileUri === comment.fileUri && fileItem.comment.specRoot === specRoot) {
        await treeView.reveal(fileItem, { expand: true, select: false, focus: false })
        await new Promise(resolve => setTimeout(resolve, 50))
        
        const commentItems = await treeProvider.getChildren(fileItem)
        
        for (const commentItem of commentItems) {
          if (commentItem.comment.commentId === comment.commentId) {
            await treeView.reveal(commentItem, { expand: false, select: true, focus: true })
            return true
          }
        }
      }
    }
    return false
  } catch (e) {
    console.error('Failed to select comment in tree:', e)
    return false
  }
}

/**
 * Show comment in sidebar and select in tree
 */
async function showCommentInSidebar(comment, specRoot, commentDetailViewProvider, commentTreeProvider, treeView) {
  await vscode.commands.executeCommand('specpressComments.focus')
  commentDetailViewProvider.showComment(comment, specRoot)
  await selectCommentInTree(commentTreeProvider, treeView, comment, specRoot)
}

module.exports = {
  selectCommentInTree,
  showCommentInSidebar
}
