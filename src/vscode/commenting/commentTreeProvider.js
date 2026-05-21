const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const { logger } = require('../logger')

/**
 * Tree item representing a comment or file group
 */
class CommentTreeItem extends vscode.TreeItem {
  constructor(label, collapsibleState, comment, itemType) {
    super(label, collapsibleState)
    this.comment = comment
    this.itemType = itemType // 'file', 'comment', 'reply'
  }
}

/**
 * Provides tree view for all comments in the workspace
 */
class CommentTreeProvider {
  constructor(commentManager, config) {
    this.commentManager = commentManager
    this.config = config
    this._onDidChangeTreeData = new vscode.EventEmitter()
    this.onDidChangeTreeData = this._onDidChangeTreeData.event
    this.filterText = ''
    this.filterAuthor = ''
    this.filterUnresolvedOnly = false
    this.selectedCommentId = null // Track selected comment for bold styling
    this.suppressRefresh = false // Flag to prevent refresh during programmatic selection
  }

  setSelectedComment(commentId, forceRefresh = false) {
    const oldSelection = this.selectedCommentId
    this.selectedCommentId = commentId
    logger.log('setSelectedComment called', { commentId, suppressRefresh: this.suppressRefresh, forceRefresh, oldSelection })
    
    if (forceRefresh && !this.suppressRefresh) {
      logger.log('Refreshing tree (forceRefresh=true and suppressRefresh=false)')
      this.refresh()
    } else if (oldSelection !== commentId && !this.suppressRefresh) {
      // Selection changed - fire update to refresh labels (💬 indicator)
      logger.log('Firing tree update for selection change (to update 💬 indicator)')
      this._onDidChangeTreeData.fire()
    } else {
      logger.log('Skipping tree update completely')
    }
  }

  setFilters(text, author, unresolvedOnly) {
    this.filterText = (text || '').toLowerCase()
    this.filterAuthor = (author || '').toLowerCase()
    this.filterUnresolvedOnly = unresolvedOnly || false
    this.refresh()
  }

  refresh() {
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element) {
    return element
  }

  getParent(element) {
    if (!element) return null

    if (element.itemType === 'reply') {
      // Reply's parent is the comment it replies to
      // We need to find the parent comment
      const parentId = element.comment.replyTo
      const specRoot = element.specRoot
      // Return a placeholder that will be resolved by the tree
      return { parentId, specRoot, itemType: 'comment' }
    }

    if (element.itemType === 'comment') {
      // Comment's parent is the file item
      const fileUri = element.comment.fileUri
      const specRoot = element.specRoot
      // Return a placeholder that will be resolved by the tree
      return { fileUri, specRoot, itemType: 'file' }
    }

    // File items have no parent (they are root level)
    return null
  }

  async getChildren(element) {
    if (!element) {
      // Root level - show files grouped by spec root
      return this.getRootItems()
    }

    if (element.itemType === 'file') {
      // File level - show top-level comments only (no replies as tree children)
      return this.getCommentsForFile(element)
    }

    // Comments no longer have tree children (replies shown in detail view)
    return []
  }

  /**
   * Get root items (files with comments)
   */
  async getRootItems() {
    const specRoots = this.config.resolveSpecRoots()
    if (specRoots.length === 0) return []

    const fileItems = []

    for (const specRoot of specRoots) {
      const commentFolder = this.commentManager.getCommentFolder(specRoot)
      if (!fs.existsSync(commentFolder)) continue

      // Get all comments from cache
      const allComments = this.commentManager.getAllComments(specRoot)

      // Apply filters
      const filteredComments = allComments.filter(comment => {
        if (this.filterText && !comment.commentText.toLowerCase().includes(this.filterText)) {
          return false
        }
        if (this.filterAuthor && !comment.authorId.toLowerCase().includes(this.filterAuthor)) {
          return false
        }
        if (this.filterUnresolvedOnly) {
          // Keep unresolved comments
          if (!comment.resolved) {
            return true
          }
          // Keep resolved comments that have unresolved replies
          if (comment.resolved && !comment.replyTo) {
            // Check if this parent has any unresolved replies
            const hasUnresolvedReplies = allComments.some(c => 
              c.replyTo === comment.commentId && !c.resolved
            )
            if (hasUnresolvedReplies) {
              return true
            }
          }
          return false
        }
        return true
      })

      // Group by file
      const fileMap = new Map()
      for (const comment of filteredComments) {
        const fileUri = comment.fileUri
        if (!fileMap.has(fileUri)) {
          fileMap.set(fileUri, [])
        }
        fileMap.get(fileUri).push(comment)
      }

      // Create tree items for each file
      for (const [fileUri, comments] of fileMap) {
        const unresolvedCount = comments.filter(c => !c.resolved && !c.replyTo).length
        const totalCount = comments.filter(c => !c.replyTo).length
        const label = `${path.basename(fileUri)} (${unresolvedCount}/${totalCount})`

        const item = new CommentTreeItem(
          label,
          vscode.TreeItemCollapsibleState.Collapsed,
          { fileUri, comments, specRoot },
          'file'
        )

        item.iconPath = new vscode.ThemeIcon('file')
        item.description = path.dirname(fileUri)
        item.tooltip = `${fileUri}\n${totalCount} comment${totalCount !== 1 ? 's' : ''}, ${unresolvedCount} unresolved`
        item.contextValue = 'commentFile'

        fileItems.push(item)
      }
    }

    // Sort by file path
    fileItems.sort((a, b) => a.comment.fileUri.localeCompare(b.comment.fileUri))

    return fileItems
  }

  /**
   * Get comments for a file (top-level only, no replies)
   */
  async getCommentsForFile(fileElement) {
    const comments = fileElement.comment.comments
      .filter(c => !c.replyTo) // Only top-level comments
      .sort((a, b) => {
        // Sort by line number first
        if (a.lineNumber !== b.lineNumber) {
          return a.lineNumber - b.lineNumber
        }
        // Then by column number
        const colA = a.columnNumber !== undefined ? a.columnNumber : 0
        const colB = b.columnNumber !== undefined ? b.columnNumber : 0
        return colA - colB
      })

    return comments.map(comment => this.createCommentItem(comment, fileElement.comment.specRoot))
  }

  /**
   * Count replies for a comment (using cached data)
   */
  countReplies(commentId, specRoot) {
    const allComments = this.commentManager.getAllComments(specRoot)
    return allComments.filter(c => c.replyTo === commentId).length
  }

  /**
   * Check if comment has unresolved replies (using cached data)
   */
  hasUnresolvedReplies(commentId, specRoot) {
    const allComments = this.commentManager.getAllComments(specRoot)
    return allComments.some(c => c.replyTo === commentId && !c.resolved)
  }

  /**
   * Get replies for a comment (using cached data)
   */
  async getRepliesForComment(commentElement) {
    const parentId = commentElement.comment.commentId
    const specRoot = commentElement.specRoot

    const allComments = this.commentManager.getAllComments(specRoot)
    const replies = allComments
      .filter(c => c.replyTo === parentId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    return replies.map(reply => this.createReplyItem(reply, specRoot))
  }

  /**
   * Create tree item for a comment
   */
  createCommentItem(comment, specRoot) {
    const isSelected = this.selectedCommentId === comment.commentId
    const replyCount = this.countReplies(comment.commentId, specRoot)
    const hasUnresolvedReplies = this.hasUnresolvedReplies(comment.commentId, specRoot)
    
    // Determine icon based on resolved status and replies
    let iconPath
    if (comment.resolved && hasUnresolvedReplies) {
      // Parent resolved but has unresolved replies - yellow check
      iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.yellow'))
    } else if (comment.resolved) {
      // Fully resolved - green check
      iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'))
    } else {
      // Unresolved - red exclamation
      iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
    }
    
    const statusPrefix = isSelected ? '→ ' : ''
    const replyInfo = replyCount > 0 ? ` [R:${replyCount}]` : ''
    const preview = comment.commentText.substring(0, 50).replace(/\n/g, ' ')
    const label = `${statusPrefix}Line ${comment.lineNumber + 1}${replyInfo}: ${preview}${comment.commentText.length > 50 ? '...' : ''}`

    // Parent comments are always non-collapsible (no tree children)
    const item = new CommentTreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
      comment,
      'comment'
    )

    item.specRoot = specRoot
    item.iconPath = iconPath
    item.description = comment.authorName
    item.tooltip = this.buildCommentTooltip(comment)
    item.contextValue = comment.authorId === this.config.userId ? 'ownComment' : 'otherComment'

    // Command to jump to line when clicked
    item.command = {
      command: 'specpress.jumpToComment',
      title: 'Jump to Comment',
      arguments: [comment, specRoot]
    }

    return item
  }

  /**
   * Check if a comment has replies (using cached data)
   */
  hasReplies(commentId, specRoot) {
    const allComments = this.commentManager.getAllComments(specRoot)
    return allComments.some(c => c.replyTo === commentId)
  }

  /**
   * Create tree item for a reply
   */
  createReplyItem(reply, specRoot) {
    const isSelected = this.selectedCommentId === reply.commentId
    const status = isSelected ? '→ ' : ''
    const preview = reply.commentText.substring(0, 40).replace(/\n/g, ' ')
    const label = `${status}↳ ${preview}${reply.commentText.length > 40 ? '...' : ''}`

    const item = new CommentTreeItem(
      label,
      vscode.TreeItemCollapsibleState.None,
      reply,
      'reply'
    )

    item.specRoot = specRoot
    item.iconPath = new vscode.ThemeIcon('arrow-small-right')
    item.description = reply.authorName
    item.tooltip = this.buildCommentTooltip(reply)
    item.contextValue = reply.authorId === this.config.userId ? 'ownReply' : 'otherReply'

    // Don't set command - let the tree selection handle it via onDidChangeSelection

    return item
  }

  /**
   * Build tooltip for a comment
   */
  buildCommentTooltip(comment) {
    const status = comment.resolved ? '✅ Resolved' : '❗ Open'
    const created = new Date(comment.createdAt).toLocaleString()
    const updated = comment.updatedAt !== comment.createdAt
      ? `\nUpdated: ${new Date(comment.updatedAt).toLocaleString()}`
      : ''

    return `${status}\n${comment.authorName}\nCreated: ${created}${updated}\n\n${comment.commentText}`
  }

  /**
   * Get all file items (for expand operations)
   */
  async getFileItems() {
    return this.getRootItems()
  }
}

module.exports = { CommentTreeProvider }
