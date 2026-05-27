const vscode = require('vscode')
const path = require('path')

/**
 * Manages visual comment decorations in the editor.
 * Subscribes to CommentManager.onDidChange to refresh.
 */
class CommentDecorationManager {
  constructor(commentManager, extensionPath) {
    this.commentManager = commentManager
    this.extensionPath = extensionPath

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

    this.movedDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: path.join(extensionPath, 'images', 'comment-unresolved.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: 'rgba(255, 0, 0, 0.8)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      backgroundColor: 'rgba(255, 165, 0, 0.2)',
      isWholeLine: true
    })

    this.columnMarkerUnresolved = vscode.window.createTextEditorDecorationType({
      before: { contentText: '\u258A', color: '#FFA500', margin: '0 1px 0 0' }
    })

    this.columnMarkerResolved = vscode.window.createTextEditorDecorationType({
      before: { contentText: '\u258A', color: '#2dcd32', margin: '0 1px 0 0' }
    })

    this.columnMarkerMoved = vscode.window.createTextEditorDecorationType({
      before: { contentText: '\u258A', color: '#ff1100', margin: '0 1px 0 0' }
    })

    this.suggestedPositionDecoration = vscode.window.createTextEditorDecorationType({
      before: { contentText: '\uD83D\uDCCD', color: 'rgba(255, 0, 0, 0.9)', margin: '0 2px 0 0', fontWeight: 'bold' },
      backgroundColor: 'rgba(255, 255, 0, 0.2)',
      borderRadius: '3px'
    })

    this.activeDecorations = new Map()
  }

  /**
   * Update decorations for the given editor.
   * Delegates position validation to CommentManager, then reads _statusKey.
   */
  async updateDecorations(editor, config) {
    if (!editor) return

    const filePath = editor.document.uri.fsPath
    if (!config.isInsideSpecRoot(filePath)) return

    const specRoot = config.getSpecRootForFile(filePath)
    const relativeUri = path.relative(specRoot, filePath).replace(/\\/g, '/')

    // Validate and stamp _statusKey on all comments for this spec root
    const validationMap = this.commentManager.validateAndUpdateStatuses(specRoot, relativeUri, editor.document)

    // Get comments for this file (same cached objects with _statusKey set)
    const comments = await this.commentManager.findCommentsForFile(relativeUri, specRoot)

    // Group by line
    const commentsByLine = new Map()
    for (const comment of comments) {
      if (!commentsByLine.has(comment.lineNumber)) commentsByLine.set(comment.lineNumber, [])
      commentsByLine.get(comment.lineNumber).push(comment)
    }

    const unresolvedDecs = [], resolvedDecs = [], movedDecs = []
    const colUnresolved = [], colResolved = [], colMoved = []
    const suggestedPositions = []

    for (const [lineNum, lineComments] of commentsByLine) {
      const hasMoved = lineComments.some(c => !c.replyTo && c._statusKey === 'moved')
      const hasUnresolved = lineComments.some(c => !c.replyTo && c._statusKey === 'unresolved')
      const range = new vscode.Range(lineNum, 0, lineNum, 0)

      if (hasMoved) {
        movedDecs.push({ range })
        for (const comment of lineComments) {
          const v = validationMap.get(comment.commentId)
          if (v && v.status === 'moved' && v.suggestedPosition) {
            const sp = v.suggestedPosition
            suggestedPositions.push({ range: new vscode.Range(sp.line, sp.character, sp.line, sp.character) })
          }
        }
      } else if (hasUnresolved) {
        unresolvedDecs.push({ range })
      } else {
        resolvedDecs.push({ range })
      }

      // Column markers for parent comments only
      for (const comment of lineComments) {
        if (!comment.replyTo && comment.columnNumber !== undefined) {
          const colRange = new vscode.Range(lineNum, comment.columnNumber, lineNum, comment.columnNumber)
          if (comment._statusKey === 'moved') colMoved.push({ range: colRange })
          else if (comment._statusKey === 'resolved') colResolved.push({ range: colRange })
          else colUnresolved.push({ range: colRange })
        }
      }
    }

    editor.setDecorations(this.unresolvedDecoration, unresolvedDecs)
    editor.setDecorations(this.resolvedDecoration, resolvedDecs)
    editor.setDecorations(this.movedDecoration, movedDecs)
    editor.setDecorations(this.columnMarkerUnresolved, colUnresolved)
    editor.setDecorations(this.columnMarkerResolved, colResolved)
    editor.setDecorations(this.columnMarkerMoved, colMoved)
    editor.setDecorations(this.suggestedPositionDecoration, suggestedPositions)

    this.activeDecorations.set(editor.document.uri.toString(), commentsByLine)
  }

  getCommentsAtPosition(editor, position) {
    const commentsByLine = this.activeDecorations.get(editor.document.uri.toString())
    if (!commentsByLine) return []
    return commentsByLine.get(position.line) || []
  }

  clear() { this.activeDecorations.clear() }

  dispose() {
    this.unresolvedDecoration.dispose()
    this.resolvedDecoration.dispose()
    this.movedDecoration.dispose()
    this.columnMarkerUnresolved.dispose()
    this.columnMarkerResolved.dispose()
    this.columnMarkerMoved.dispose()
    this.suggestedPositionDecoration.dispose()
  }
}

module.exports = { CommentDecorationManager }
