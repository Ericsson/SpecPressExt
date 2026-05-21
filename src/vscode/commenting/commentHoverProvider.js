const vscode = require('vscode')
const path = require('path')

/**
 * Provides hover information for lines with comments.
 */
class CommentHoverProvider {
  constructor(commentManager, config) {
    this.commentManager = commentManager
    this.config = config
  }

  async provideHover(document, position) {
    const filePath = document.uri.fsPath
    if (!this.config.isInsideSpecRoot(filePath)) return null

    const specRoot = this.config.getSpecRootForFile(filePath)
    const relativeUri = path.relative(specRoot, filePath).replace(/\\/g, '/')

    // Find all comments for this file
    const comments = await this.commentManager.findCommentsForFile(relativeUri, specRoot)

    // Find parent comments (not replies) for this line
    const parentComments = comments.filter(c => c.lineNumber === position.line && !c.replyTo)
    if (parentComments.length === 0) return null

    // Sort by distance from cursor column
    const cursorColumn = position.character
    parentComments.sort((a, b) => {
      const distA = Math.abs((a.columnNumber || 0) - cursorColumn)
      const distB = Math.abs((b.columnNumber || 0) - cursorColumn)
      return distA - distB
    })

    // Find the minimum distance
    const minDistance = Math.abs((parentComments[0].columnNumber || 0) - cursorColumn)
    
    // Get all parent comments at the minimum distance
    const nearestParents = parentComments.filter(c => 
      Math.abs((c.columnNumber || 0) - cursorColumn) === minDistance
    )

    // Build hover content with clickable entries
    const lines = []
    lines.push('### 💬 Comments')
    lines.push('')

    for (let i = 0; i < nearestParents.length; i++) {
      const parent = nearestParents[i]
      this.renderCommentWithReplies(parent, comments, specRoot, lines, 0)

      if (i < nearestParents.length - 1) {
        lines.push('')
        lines.push('---')
        lines.push('')
      }
    }

    lines.push('')
    lines.push('*Click a comment header to view in sidebar*')

    const markdown = new vscode.MarkdownString(lines.join('\n'))
    markdown.isTrusted = true
    markdown.supportHtml = true

    return new vscode.Hover(markdown)
  }

  renderCommentWithReplies(comment, allComments, specRoot, lines, depth) {
    const indent = '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(depth)
    
    // Determine status icon based on resolved state and replies
    let statusIcon
    if (comment.resolved) {
      // Check if has unresolved replies
      const allReplies = this.getAllReplies(comment.commentId, allComments)
      const hasUnresolvedReplies = allReplies.some(r => !r.resolved)
      
      if (hasUnresolvedReplies) {
        statusIcon = '✓ Resolved (has unresolved replies)'
      } else {
        statusIcon = '✅ Resolved'
      }
    } else {
      statusIcon = '❗ Open'
    }
    
    const date = new Date(comment.createdAt).toLocaleDateString()
    const time = new Date(comment.createdAt).toLocaleTimeString()
    const colInfo = comment.columnNumber !== undefined ? ` [Col ${comment.columnNumber}]` : ''

    // Create command URI to show this comment
    const commandUri = encodeURI(`command:specpress.showCommentFromHover?${JSON.stringify([comment.commentId, specRoot])}`)
    
    lines.push(`${indent}[**${statusIcon}** — **${comment.authorName}**${colInfo} — ${date} ${time}](${commandUri})`)
    
    if (comment.updatedAt !== comment.createdAt) {
      const editDate = new Date(comment.updatedAt).toLocaleDateString()
      const editTime = new Date(comment.updatedAt).toLocaleTimeString()
      lines.push(`${indent}*Edited: ${editDate} ${editTime}*`)
    }
    
    lines.push('')
    
    // Indent comment text
    const commentLines = comment.commentText.split('\n')
    for (const line of commentLines) {
      lines.push(`${indent}${line}`)
    }

    // Find and render replies recursively
    const replies = allComments.filter(c => c.replyTo === comment.commentId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    
    if (replies.length > 0) {
      lines.push('')
      for (const reply of replies) {
        this.renderCommentWithReplies(reply, allComments, specRoot, lines, depth + 1)
      }
    }
  }

  getAllReplies(parentId, allComments) {
    const result = []
    const directReplies = allComments.filter(c => c.replyTo === parentId)
    for (const reply of directReplies) {
      result.push(reply)
      result.push(...this.getAllReplies(reply.commentId, allComments))
    }
    return result
  }
}

module.exports = { CommentHoverProvider }
