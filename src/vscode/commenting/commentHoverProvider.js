const vscode = require('vscode')
const path = require('path')
const { statusHoverIcon, STATUS } = require('./commentStyles')

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

    // Build hover content
    const lines = []

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
    markdown.supportThemeIcons = true

    return new vscode.Hover(markdown)
  }

  renderCommentWithReplies(comment, allComments, specRoot, lines, depth) {
    const indent = '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(depth)
    const isReply = !!comment.replyTo
    
    const date = new Date(comment.createdAt).toLocaleDateString()
    const time = new Date(comment.createdAt).toLocaleTimeString()

    // Create command URI to show this comment
    const commandUri = encodeURI(`command:specpress.showCommentFromHover?${JSON.stringify([comment.commentId, specRoot])}`)
    
    if (isReply) {
      // Replies don't have status
      lines.push(`${indent}[**${comment.authorName}** — ${date} ${time}](${commandUri})`)
    } else {
      // Parent comments have status
      const statusKey = comment._statusKey || (comment.resolved ? 'resolved' : 'unresolved')
      const statusLabel = STATUS[statusKey].label
      lines.push(`${indent}${statusHoverIcon(statusKey)} [**${statusLabel}** — **${comment.authorName}** — ${date} ${time}](${commandUri})`)
    }
    
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
}

module.exports = { CommentHoverProvider }
