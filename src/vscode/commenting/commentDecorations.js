const vscode = require('vscode')
const path = require('path')
const { validateCommentPosition } = require('./commentPositionValidator')

/**
 * Manages visual comment decorations in the editor.
 */
class CommentDecorationManager {
  constructor(commentManager, extensionPath) {
    this.commentManager = commentManager
    this.extensionPath = extensionPath

    // Create decoration types for different comment states
    this.unresolvedDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'images', 'comment-unresolved.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: 'rgba(255, 165, 0, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Right
    })

    this.resolvedDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'images', 'comment-resolved.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: 'rgba(0, 255, 0, 0.5)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      opacity: '0.6'
    })

    // Warning decoration for comments that may have moved
    this.movedDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'images', 'comment-unresolved.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: 'rgba(255, 0, 0, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      backgroundColor: 'rgba(255, 165, 0, 0.2)',
      isWholeLine: true
    })

    // Inline decoration for column position (small marker)
    this.columnMarkerDecoration = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: '💬',
        color: 'rgba(255, 165, 0, 0.8)',
        margin: '0 2px 0 0'
      }
    })

    // Suggested position marker for moved comments
    this.suggestedPositionDecoration = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: '📍',
        color: 'rgba(255, 0, 0, 0.9)',
        margin: '0 2px 0 0',
        fontWeight: 'bold'
      },
      backgroundColor: 'rgba(255, 255, 0, 0.2)',
      borderRadius: '3px'
    })

    // Store active decorations by editor
    this.activeDecorations = new Map()
  }

  /**
   * Update decorations for the given editor
   */
  async updateDecorations(editor, config) {
    if (!editor) return

    const filePath = editor.document.uri.fsPath
    if (!config.isInsideSpecRoot(filePath)) return

    const specRoot = config.getSpecRootForFile(filePath)
    const relativeUri = path.relative(specRoot, filePath).replace(/\\/g, '/')

    // Find all comments for this file
    const comments = await this.commentManager.findCommentsForFile(relativeUri, specRoot)

    // Group comments by line number
    const commentsByLine = new Map()
    for (const comment of comments) {
      const line = comment.lineNumber
      if (!commentsByLine.has(line)) {
        commentsByLine.set(line, [])
      }
      commentsByLine.get(line).push(comment)
    }

    // Build decorations
    const unresolvedDecorations = []
    const resolvedDecorations = []
    const movedDecorations = []
    const columnMarkers = []
    const suggestedPositions = []

    for (const [lineNum, lineComments] of commentsByLine) {
      const hasUnresolved = lineComments.some(c => !c.resolved)
      
      // Validate comment positions
      const validations = lineComments.map(c => ({
        comment: c,
        validation: validateCommentPosition(c, editor.document)
      }))
      
      const hasMoved = validations.some(v => !v.validation.valid && v.validation.status !== 'no-snippet')
      
      const range = new vscode.Range(lineNum, 0, lineNum, 0)

      // Build hover message with validation warnings
      const hoverMessage = this.buildHoverMessage(lineComments, validations)

      const decoration = {
        range,
        hoverMessage
      }

      if (hasMoved) {
        movedDecorations.push(decoration)
        
        // Add suggested position markers
        for (const v of validations) {
          if (!v.validation.valid && v.validation.status === 'moved' && v.validation.suggestedPosition) {
            const suggestedPos = v.validation.suggestedPosition
            const suggestedRange = new vscode.Range(suggestedPos.line, suggestedPos.character, suggestedPos.line, suggestedPos.character)
            
            // Build hover message for suggested position
            const suggestedHover = this.buildSuggestedPositionHover(v.comment, suggestedPos)
            
            suggestedPositions.push({
              range: suggestedRange,
              hoverMessage: suggestedHover
            })
          }
        }
      } else if (hasUnresolved) {
        unresolvedDecorations.push(decoration)
      } else {
        resolvedDecorations.push(decoration)
      }

      // Add column markers for comments with specific column positions
      // Only show markers for parent comments (not replies)
      for (const comment of lineComments) {
        if (!comment.replyTo && comment.columnNumber !== undefined && comment.columnNumber > 0) {
          const colRange = new vscode.Range(lineNum, comment.columnNumber, lineNum, comment.columnNumber)
          columnMarkers.push({
            range: colRange,
            hoverMessage: this.buildHoverMessage([comment])
          })
        }
      }
    }

    // Apply decorations
    editor.setDecorations(this.unresolvedDecoration, unresolvedDecorations)
    editor.setDecorations(this.resolvedDecoration, resolvedDecorations)
    editor.setDecorations(this.movedDecoration, movedDecorations)
    editor.setDecorations(this.columnMarkerDecoration, columnMarkers)
    editor.setDecorations(this.suggestedPositionDecoration, suggestedPositions)

    // Store for click handling
    this.activeDecorations.set(editor.document.uri.toString(), commentsByLine)
  }

  /**
   * Build hover message for suggested position marker
   */
  buildSuggestedPositionHover(comment, suggestedPos) {
    const lines = []
    
    lines.push('📍 **Suggested new position for comment**')
    lines.push('')
    lines.push(`Original: Line ${comment.lineNumber + 1}, Column ${comment.columnNumber || 0}`)
    lines.push(`Suggested: Line ${suggestedPos.line + 1}, Column ${suggestedPos.character}`)
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push(`**Comment by ${comment.authorName}:**`)
    lines.push('')
    lines.push(comment.commentText.substring(0, 100) + (comment.commentText.length > 100 ? '...' : ''))
    lines.push('')
    lines.push('---')
    lines.push('')
    lines.push('ℹ️ *Click the 💬 icon at the original position to open comment details*')
    lines.push('ℹ️ *Use "Validate Comment Positions" command to update*')
    
    const markdown = new vscode.MarkdownString(lines.join('\n'))
    markdown.isTrusted = true
    markdown.supportHtml = true
    
    return markdown
  }

  /**
   * Build rich hover message with comment details and validation warnings
   */
  buildHoverMessage(comments, validations = null) {
    const lines = []

    for (let i = 0; i < comments.length; i++) {
      const comment = comments[i]
      const validation = validations ? validations[i].validation : null
      
      // Add validation warning if comment may have moved
      if (validation && !validation.valid && validation.status !== 'no-snippet') {
        lines.push('⚠️ **WARNING: Comment position may have changed**')
        
        if (validation.status === 'moved' && validation.suggestedPosition) {
          const suggestedLine = validation.suggestedPosition.line + 1
          const suggestedCol = validation.suggestedPosition.character
          lines.push(`*Possible new location: Line ${suggestedLine}, Column ${suggestedCol}*`)
        } else if (validation.status === 'not-found') {
          lines.push('*Original text not found nearby*')
        } else if (validation.status === 'line-out-of-range') {
          lines.push('*Line number is out of range*')
        }
        
        lines.push('')
      }
      
      const status = comment.resolved ? '✓ Resolved' : '💬 Open'
      const date = new Date(comment.createdAt).toLocaleString()
      const updated = comment.updatedAt !== comment.createdAt
        ? ` (edited ${new Date(comment.updatedAt).toLocaleString()})`
        : ''

      lines.push(`**${status}** — ${comment.authorName} — ${date}${updated}`)
      lines.push('')
      lines.push(comment.commentText)

      if (comment.replyTo) {
        lines.push('')
        lines.push('↳ *Reply to another comment*')
      }

      lines.push('')
      lines.push('---')
      lines.push('')
    }

    // Remove trailing separator
    if (lines.length > 0) {
      lines.pop()
      lines.pop()
    }

    const markdown = new vscode.MarkdownString(lines.join('\n'))
    markdown.isTrusted = true
    markdown.supportHtml = true

    return markdown
  }

  /**
   * Get comments at a specific position (for click handling)
   */
  getCommentsAtPosition(editor, position) {
    const uri = editor.document.uri.toString()
    const commentsByLine = this.activeDecorations.get(uri)
    if (!commentsByLine) return []

    return commentsByLine.get(position.line) || []
  }

  /**
   * Clear all decorations
   */
  clear() {
    this.activeDecorations.clear()
  }

  /**
   * Dispose decoration types
   */
  dispose() {
    this.unresolvedDecoration.dispose()
    this.resolvedDecoration.dispose()
    this.movedDecoration.dispose()
    this.columnMarkerDecoration.dispose()
    this.suggestedPositionDecoration.dispose()
  }
}

module.exports = { CommentDecorationManager }
