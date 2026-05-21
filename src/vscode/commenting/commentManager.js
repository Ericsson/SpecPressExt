const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

/**
 * Manages comment files for specification documents.
 */
class CommentManager {
  constructor(config) {
    this.config = config
    this._cache = new Map() // Cache: specRoot -> { comments: [], timestamp: number }
    this._cacheTimeout = 300000 // Cache valid for 5 minutes (invalidated on any write)
  }

  /**
   * Invalidate cache for a spec root
   */
  invalidateCache(specRoot) {
    this._cache.delete(specRoot)
  }

  /**
   * Clear all caches
   */
  clearCache() {
    this._cache.clear()
  }

  /**
   * Get comment folder path (sibling to spec root)
   */
  getCommentFolder(specRoot) {
    const parent = path.dirname(specRoot)
    const folderName = this.config.commentFolder || 'comments'
    return path.join(parent, folderName)
  }

  /**
   * Generate unique comment ID
   */
  generateCommentId(authorId) {
    const random = crypto.randomBytes(3).toString('hex')
    return `${authorId}_${random}.json`
  }

  /**
   * Normalize file URI to use forward slashes
   */
  normalizeUri(fileUri) {
    return fileUri.replace(/\\/g, '/')
  }

  /**
   * Get current git commit hash
   */
  async getCurrentCommitHash(specRoot) {
    try {
      return execSync('git rev-parse HEAD', { cwd: specRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    } catch (e) {
      return null
    }
  }

  /**
   * Create new comment or reply
   */
  async _createCommentInternal(fileUri, lineNumber, columnNumber, lineSnippet, commentText, specRoot, replyTo = null) {
    const authorId = this.config.userId
    const authorName = this.config.userName

    if (!authorId || !authorName) {
      throw new Error('Configure specpress.userId and specpress.userName in settings')
    }

    const gitHash = await this.getCurrentCommitHash(specRoot)
    const commentId = this.generateCommentId(authorId)

    const comment = {
      commentId,
      authorId,
      authorName,
      fileUri: this.normalizeUri(fileUri),
      lineNumber,
      columnNumber,
      lineSnippet,
      commentText,
      replyTo,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolved: false,
      createdInCommit: gitHash,
      resolvedInCommit: null
    }

    const commentFolder = this.getCommentFolder(specRoot)
    if (!fs.existsSync(commentFolder)) {
      fs.mkdirSync(commentFolder, { recursive: true })
    }

    const commentPath = path.join(commentFolder, commentId)
    fs.writeFileSync(commentPath, JSON.stringify(comment, null, 2))

    // Invalidate cache after write
    this.invalidateCache(specRoot)

    return comment
  }

  /**
   * Create new comment
   */
  async createComment(fileUri, lineNumber, columnNumber, lineSnippet, commentText, specRoot) {
    return this._createCommentInternal(fileUri, lineNumber, columnNumber, lineSnippet, commentText, specRoot, null)
  }

  /**
   * Create reply to existing comment
   */
  async createReply(parentCommentId, fileUri, lineNumber, columnNumber, lineSnippet, commentText, specRoot) {
    return this._createCommentInternal(fileUri, lineNumber, columnNumber, lineSnippet, commentText, specRoot, parentCommentId)
  }

  /**
   * Find all comments for a specific file
   */
  async findCommentsForFile(fileUri, specRoot) {
    const commentFolder = this.getCommentFolder(specRoot)
    if (!fs.existsSync(commentFolder)) return []

    const normalized = this.normalizeUri(fileUri)
    const comments = []

    const files = fs.readdirSync(commentFolder)
    for (const file of files) {
      if (!file.endsWith('.json')) continue

      try {
        const commentPath = path.join(commentFolder, file)
        const content = fs.readFileSync(commentPath, 'utf8')
        const comment = JSON.parse(content)

        if (this.normalizeUri(comment.fileUri) === normalized) {
          comments.push(comment)
        }
      } catch (e) {
        // Skip invalid JSON files
      }
    }

    return comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }

  /**
   * Update comment text
   */
  async updateComment(commentId, specRoot, newText) {
    const commentFolder = this.getCommentFolder(specRoot)
    const commentPath = path.join(commentFolder, commentId)

    if (!fs.existsSync(commentPath)) {
      throw new Error('Comment not found')
    }

    const content = fs.readFileSync(commentPath, 'utf8')
    const comment = JSON.parse(content)

    comment.commentText = newText
    comment.updatedAt = new Date().toISOString()

    fs.writeFileSync(commentPath, JSON.stringify(comment, null, 2))
    this.invalidateCache(specRoot)
  }

  /**
   * Resolve or unresolve comment
   */
  async resolveComment(commentId, specRoot, resolved, resolvedBy) {
    const commentFolder = this.getCommentFolder(specRoot)
    const commentPath = path.join(commentFolder, commentId)

    if (!fs.existsSync(commentPath)) {
      throw new Error('Comment not found')
    }

    const content = fs.readFileSync(commentPath, 'utf8')
    const comment = JSON.parse(content)

    comment.resolved = resolved
    comment.resolvedBy = resolved ? resolvedBy : null
    comment.updatedAt = new Date().toISOString()

    if (resolved && !comment.resolvedInCommit) {
      comment.resolvedInCommit = await this.getCurrentCommitHash(specRoot)
    } else if (!resolved) {
      comment.resolvedInCommit = null
    }

    fs.writeFileSync(commentPath, JSON.stringify(comment, null, 2))
    this.invalidateCache(specRoot)
  }

  /**
   * Get all comments for a spec root (with caching)
   */
  getAllComments(specRoot) {
    const now = Date.now()
    const cached = this._cache.get(specRoot)
    
    // Return cached data if still valid
    if (cached && (now - cached.timestamp) < this._cacheTimeout) {
      return cached.comments
    }

    // Read from disk
    const commentFolder = this.getCommentFolder(specRoot)
    if (!fs.existsSync(commentFolder)) {
      this._cache.set(specRoot, { comments: [], timestamp: now })
      return []
    }

    const comments = []
    const files = fs.readdirSync(commentFolder)
    for (const file of files) {
      if (!file.endsWith('.json')) continue

      try {
        const commentPath = path.join(commentFolder, file)
        const content = fs.readFileSync(commentPath, 'utf8')
        const comment = JSON.parse(content)
        comments.push(comment)
      } catch (e) {
        // Skip invalid files
      }
    }

    // Cache the result
    this._cache.set(specRoot, { comments, timestamp: now })
    return comments
  }
}

module.exports = { CommentManager }
