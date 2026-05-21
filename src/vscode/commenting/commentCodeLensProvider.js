const vscode = require('vscode')
const path = require('path')

/**
 * Provides CodeLens for comment indicators.
 */
class CommentCodeLensProvider {
  constructor(commentManager, config) {
    this.commentManager = commentManager
    this.config = config
    this._onDidChangeCodeLenses = new vscode.EventEmitter()
    this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event
  }

  async provideCodeLenses(document) {
    const filePath = document.uri.fsPath
    if (!this.config.isInsideSpecRoot(filePath)) return []

    const specRoot = this.config.getSpecRootForFile(filePath)
    const relativeUri = path.relative(specRoot, filePath).replace(/\\/g, '/')

    const comments = await this.commentManager.findCommentsForFile(relativeUri, specRoot)

    // Group by line
    const commentsByLine = new Map()
    for (const comment of comments) {
      if (!commentsByLine.has(comment.lineNumber)) {
        commentsByLine.set(comment.lineNumber, [])
      }
      commentsByLine.get(comment.lineNumber).push(comment)
    }

    const codeLenses = []
    for (const [lineNum, lineComments] of commentsByLine) {
      const range = new vscode.Range(lineNum, 0, lineNum, 0)
      // Count only top-level comments (not replies) on this line
      const topLevelComments = lineComments.filter(c => !c.replyTo)
      const count = topLevelComments.length
      const unresolvedCount = topLevelComments.filter(c => !c.resolved).length

      const label = unresolvedCount > 0
        ? `💬 ${unresolvedCount} comment${unresolvedCount > 1 ? 's' : ''}`
        : `✓ ${count} resolved`

      codeLenses.push(new vscode.CodeLens(range, {
        title: label,
        command: 'specpress.handleCommentClick',
        arguments: [document.uri, lineNum]
      }))
    }

    return codeLenses
  }

  refresh() {
    this._onDidChangeCodeLenses.fire()
  }
}

module.exports = { CommentCodeLensProvider }
