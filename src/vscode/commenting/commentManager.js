const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const { getStatus } = require('./commentStyles')
const { validateCommentPosition } = require('./commentPositionValidator')
const { extractSnippet } = require('./snippetExtractor')

/**
 * Central comment manager. Owns the cache, watches for file changes,
 * computes _statusKey on all comments, and emits onDidChange so views refresh.
 */
class CommentManager {
  constructor(config) {
    this.config = config
    this._cache = new Map() // specRoot -> { comments: [], timestamp: number }
    this._cacheTimeout = 300000
    this._onDidChange = new vscode.EventEmitter()
    this.onDidChange = this._onDidChange.event
    this._watchers = []
  }

  /**
   * Start watching comment folders. Call once during activation.
   */
  startWatching() {
    const specRoots = this.config.resolveSpecRoots()
    for (const specRoot of specRoots) {
      let commentFolder
      try { commentFolder = this.getCommentFolder(specRoot) } catch (e) { continue }
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(commentFolder, '*.json')
      )
      const handler = () => {
        this.invalidateCache(specRoot)
        this._recomputeStatuses(specRoot)
        this._onDidChange.fire()
      }
      watcher.onDidCreate(handler)
      watcher.onDidChange(handler)
      watcher.onDidDelete(handler)
      this._watchers.push(watcher)
    }
  }

  /**
   * Dispose watchers.
   */
  dispose() {
    for (const w of this._watchers) w.dispose()
    this._watchers = []
    this._onDidChange.dispose()
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
   * Get comment folder path
   */
  getCommentFolder(specRoot) {
    const folderName = this.config.commentFolder
    if (!folderName) {
      throw new Error(
        'Comment folder not configured. Set specpress.commentFolder in settings.json.\n' +
        'Example: "specpress.commentFolder": "comments" (creates folder as sibling to spec root)\n' +
        'Security note: Comments folder will be outside spec root by default.'
      )
    }
    let commentFolder
    if (path.isAbsolute(folderName)) {
      commentFolder = folderName
    } else {
      const parent = path.dirname(specRoot)
      commentFolder = path.join(parent, folderName)
    }
    const normalized = path.normalize(commentFolder)
    if (normalized !== commentFolder) {
      throw new Error(
        `Invalid comment folder path: "${folderName}". ` +
        'Path normalization changed the path, which may indicate a security issue.'
      )
    }
    return commentFolder
  }

  generateCommentId(authorId) {
    const random = crypto.randomBytes(3).toString('hex')
    return `${authorId}_${random}.json`
  }

  normalizeUri(fileUri) {
    return fileUri.replace(/\\/g, '/')
  }

  async getCurrentCommitHash(specRoot) {
    try {
      return execSync('git rev-parse HEAD', { cwd: specRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    } catch (e) {
      return null
    }
  }

  /**
   * Create new comment or reply (internal).
   */
  async _createCommentInternal(fileUri, lineNumber, columnNumber, lineSnippet, commentText, specRoot, replyTo = null) {
    if (replyTo && lineSnippet) {
      throw new Error('A reply comment must not have a lineSnippet (it follows its parent)')
    }
    if (!replyTo && !lineSnippet) {
      throw new Error('A parent comment must have a lineSnippet for position validation')
    }

    const authorId = this.config.userId
    const authorName = this.config.userName
    if (!authorId || !authorName) {
      throw new Error('Configure specpress.userId and specpress.userName in settings')
    }

    const gitHash = await this.getCurrentCommitHash(specRoot)
    const commentId = this.generateCommentId(authorId)

    const comment = {
      commentId, authorId, authorName,
      fileUri: this.normalizeUri(fileUri),
      lineNumber, columnNumber,
      lineSnippet: lineSnippet || null,
      commentText,
      replyTo: replyTo || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdInCommit: gitHash
    }

    // Only parent comments have resolved status
    if (!replyTo) {
      comment.resolved = false
      comment.resolvedInCommit = null
    }

    const commentFolder = this.getCommentFolder(specRoot)
    if (!fs.existsSync(commentFolder)) {
      fs.mkdirSync(commentFolder, { recursive: true })
    }
    fs.writeFileSync(path.join(commentFolder, commentId), JSON.stringify(comment, null, 2))
    this.invalidateCache(specRoot)
    this._onDidChange.fire()
    return comment
  }

  async createComment(fileUri, lineNumber, columnNumber, lineSnippet, commentText, specRoot) {
    return this._createCommentInternal(fileUri, lineNumber, columnNumber, lineSnippet, commentText, specRoot, null)
  }

  async createReply(parentCommentId, commentText, specRoot) {
    const commentFolder = this.getCommentFolder(specRoot)
    const parentPath = path.join(commentFolder, parentCommentId)
    if (!fs.existsSync(parentPath)) {
      throw new Error('Parent comment not found')
    }
    const parent = JSON.parse(fs.readFileSync(parentPath, 'utf8'))
    return this._createCommentInternal(
      parent.fileUri, parent.lineNumber, parent.columnNumber,
      null, commentText, specRoot, parentCommentId
    )
  }

  /**
   * Find all comments for a specific file (from cache).
   */
  async findCommentsForFile(fileUri, specRoot) {
    const normalized = this.normalizeUri(fileUri)
    const allComments = this.getAllComments(specRoot)
    return allComments
      .filter(c => this.normalizeUri(c.fileUri) === normalized)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  }

  async updateComment(commentId, specRoot, newText) {
    const commentFolder = this.getCommentFolder(specRoot)
    const commentPath = path.join(commentFolder, commentId)
    if (!fs.existsSync(commentPath)) throw new Error('Comment not found')
    const comment = JSON.parse(fs.readFileSync(commentPath, 'utf8'))
    comment.commentText = newText
    comment.updatedAt = new Date().toISOString()
    fs.writeFileSync(commentPath, JSON.stringify(comment, null, 2))
    this.invalidateCache(specRoot)
    this._onDidChange.fire()
  }

  async resolveComment(commentId, specRoot, resolved, resolvedBy) {
    const commentFolder = this.getCommentFolder(specRoot)
    const commentPath = path.join(commentFolder, commentId)
    if (!fs.existsSync(commentPath)) throw new Error('Comment not found')
    const comment = JSON.parse(fs.readFileSync(commentPath, 'utf8'))
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
    this._onDidChange.fire()
  }

  /**
   * Get all comments for a spec root (with caching).
   */
  getAllComments(specRoot) {
    const now = Date.now()
    const cached = this._cache.get(specRoot)
    if (cached && (now - cached.timestamp) < this._cacheTimeout) {
      return cached.comments
    }

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
        const content = fs.readFileSync(path.join(commentFolder, file), 'utf8')
        const comment = JSON.parse(content)
        if (comment.replyTo && comment.lineSnippet) comment.lineSnippet = null
        comment._statusKey = null
        comments.push(comment)
      } catch (e) { /* skip */ }
    }

    this._cache.set(specRoot, { comments, timestamp: now })
    return comments
  }

  /**
   * Validate positions for comments in a specific file and recompute _statusKey
   * for ALL comments in that spec root. Called when an editor becomes active or
   * document content changes.
   * @param {string} specRoot
   * @param {string} fileUri - relative file URI being validated
   * @param {object} document - VS Code TextDocument for position validation
   */
  validateAndUpdateStatuses(specRoot, fileUri, document) {
    const comments = this.getAllComments(specRoot)
    const normalized = this.normalizeUri(fileUri)

    // Validate positions for comments in the given file
    const validationMap = new Map()
    for (const comment of comments) {
      if (this.normalizeUri(comment.fileUri) === normalized) {
        validationMap.set(comment.commentId, validateCommentPosition(comment, document))
      }
    }

    // Compute _statusKey for parent comments only
    for (const comment of comments) {
      if (comment.replyTo) {
        comment._statusKey = null // Replies have no status
        continue
      }
      const validation = validationMap.get(comment.commentId)
      const hasMoved = validation && !validation.valid && validation.status !== 'no-snippet' && validation.status !== 'reply'
      comment._statusKey = getStatus(comment, { hasMoved, hasUnresolvedReplies: false })
    }

    return validationMap
  }

  /**
   * Recompute _statusKey without position validation (e.g. after file watcher fires).
   * Uses last known validation state (hasMoved = false for all).
   */
  _recomputeStatuses(specRoot) {
    const comments = this.getAllComments(specRoot)
    for (const comment of comments) {
      if (comment.replyTo) {
        comment._statusKey = null // Replies have no status
        continue
      }
      comment._statusKey = getStatus(comment, { hasMoved: false, hasUnresolvedReplies: false })
    }
  }

  /**
   * Auto-update comment positions on document save if safe to do so.
   * Only updates if: exact match, single result, distance < 10 lines.
   * Returns object with count and details of updates.
   */
  async autoUpdateOnSave(document, specRoot) {
    const relativeUri = path.relative(specRoot, document.uri.fsPath).replace(/\\/g, '/')

    // Get comments for this file
    const comments = await this.findCommentsForFile(relativeUri, specRoot)
    const parentComments = comments.filter(c => !c.replyTo)
    
    if (parentComments.length === 0) return { count: 0, details: [] }
    
    let autoUpdated = 0
    const updatedComments = []

    for (const comment of parentComments) {
      const validation = validateCommentPosition(comment, document)
      
      // Only auto-update if safe: exact match, close distance
      if (validation.valid) continue // Already valid, skip
      if (validation.status !== 'moved') continue // Not moved or not found
      if (!validation.suggestedPosition) continue // No suggestion
      
      const distance = Math.abs(validation.suggestedPosition.line - comment.lineNumber)
      if (distance >= 10) continue // Moved too far, not safe
      
      // Check if this is the ONLY match (not ambiguous)
      const snippet = comment.lineSnippet
      if (!snippet) continue
      
      let matchCount = 0
      const searchRadius = 50
      const startLine = Math.max(0, comment.lineNumber - searchRadius)
      const endLine = Math.min(document.lineCount - 1, comment.lineNumber + searchRadius)
      
      for (let line = startLine; line <= endLine; line++) {
        const lineText = document.lineAt(line).text
        for (let col = 0; col <= lineText.length; col++) {
          const position = new vscode.Position(line, col)
          const candidateSnippet = extractSnippet(document, position)
          
          if (candidateSnippet === snippet) {
            matchCount++
            if (matchCount > 1) break // Multiple matches, not safe
          }
        }
        if (matchCount > 1) break
      }
      
      if (matchCount !== 1) continue // Not exactly one match, not safe
      
      // Safe to auto-update
      try {
        const newPos = validation.suggestedPosition
        const commentPath = path.join(this.getCommentFolder(specRoot), comment.commentId)
        const content = JSON.parse(fs.readFileSync(commentPath, 'utf8'))
        
        content.lineNumber = newPos.line
        content.columnNumber = newPos.character
        
        // Extract new snippet at new position using centralized function
        content.lineSnippet = extractSnippet(document, newPos)
        
        content.updatedAt = new Date().toISOString()
        
        fs.writeFileSync(commentPath, JSON.stringify(content, null, 2))
        
        autoUpdated++
        updatedComments.push(`Line ${comment.lineNumber + 1} → ${newPos.line + 1}`)
      } catch (e) {
        console.error(`Failed to auto-update comment ${comment.commentId}:`, e)
      }
    }
    
    // Invalidate cache once after all updates (fires onDidChange)
    if (autoUpdated > 0) {
      this.invalidateCache(specRoot)
      this._onDidChange.fire()
    }
    
    return { count: autoUpdated, details: updatedComments }
  }
}

module.exports = { CommentManager }
