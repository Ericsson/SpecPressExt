const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const { getToolbarCss, getToolbarScript } = require('../markdownEditorToolbar')

/**
 * Webview provider for comment details in the sidebar
 */
class CommentDetailViewProvider {
  constructor(commentManager, config, extensionPath) {
    this.commentManager = commentManager
    this.config = config
    this.extensionPath = extensionPath
    this._view = null
    this.currentComment = null
    this.currentSpecRoot = null
    this.commentTreeProvider = null
  }

  setTreeProvider(treeProvider) {
    this.commentTreeProvider = treeProvider
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    }

    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'resolve':
          await this.resolveCommentById(message.commentId, message.resolved)
          break
        case 'delete':
          await this.deleteCommentById(message.commentId)
          break
        case 'openJson':
          await this.openCommentJsonById(message.commentId)
          break
        case 'reply':
          await this.handleReplyToParent(message.parentCommentId)
          break
        case 'reconfirmPosition':
          await this.reconfirmCommentPosition(message.commentId)
          break
        case 'startEdit':
          // Just refresh to show edit mode - state is managed in webview
          break
        case 'saveEdit':
          await this.saveCommentEdit(message.commentId, message.newText)
          break
        case 'cancelEdit':
          // No need to refresh - webview handles UI update
          break
      }
    })

    this.updateView()
  }

  showComment(comment, specRoot) {
    // If this is a reply, find and show its parent instead
    if (comment.replyTo) {
      const allComments = this.commentManager.getAllComments(specRoot)
      const parent = allComments.find(c => c.commentId === comment.replyTo)
      if (parent) {
        this.currentComment = parent
        this.currentSpecRoot = specRoot
        this.updateView()

        if (this.commentTreeProvider) {
          this.commentTreeProvider.setSelectedComment(parent.commentId)
        }
        return
      }
    }

    this.currentComment = comment
    this.currentSpecRoot = specRoot
    this.updateView()

    if (this.commentTreeProvider) {
      this.commentTreeProvider.setSelectedComment(comment.commentId)
    }
  }

  updateView() {
    if (!this._view) return

    if (!this.currentComment) {
      this._view.webview.html = this.getEmptyStateHtml()
    } else {
      this._view.webview.html = this.getCommentHtml(this.currentComment)
    }
  }

  async saveCommentEdit(commentId, newText) {
    if (!this.currentSpecRoot) {
      this.sendMessageToWebview({ type: 'editComplete' })
      return
    }

    const userId = this.config.userId
    const allComments = this.commentManager.getAllComments(this.currentSpecRoot)
    const comment = allComments.find(c => c.commentId === commentId)
    
    if (!comment) {
      this.sendMessageToWebview({ type: 'editComplete' })
      return
    }

    // Warn when editing another author's comment
    if (comment.authorId !== userId) {
      const confirm = await vscode.window.showWarningMessage(
        `Edit comment by ${comment.authorName}?`,
        { modal: true, detail: 'Editing another author\'s comment may cause merge conflicts.' },
        'Edit'
      )
      if (confirm !== 'Edit') {
        this.sendMessageToWebview({ type: 'editComplete' })
        return
      }
    }

    if (!newText || newText.trim().length === 0) {
      vscode.window.showErrorMessage('Comment text cannot be empty')
      this.sendMessageToWebview({ type: 'editComplete' })
      return
    }

    if (newText === comment.commentText) {
      this.sendMessageToWebview({ type: 'editComplete' })
      return
    }

    try {
      await this.commentManager.updateComment(commentId, this.currentSpecRoot, newText)

      // Reload the current comment from disk
      const updatedComments = this.commentManager.getAllComments(this.currentSpecRoot)
      const updatedCurrent = updatedComments.find(c => c.commentId === this.currentComment.commentId)
      if (updatedCurrent) {
        this.currentComment = updatedCurrent
      }

      vscode.window.showInformationMessage('Comment updated')
      
      // Refresh tree in background (don't wait)
      vscode.commands.executeCommand('specpress.refreshCommentTree')
      
      // Tell webview to exit edit mode and refresh
      this.updateView()
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to update: ${e.message}`)
      this.sendMessageToWebview({ type: 'editComplete' })
    }
  }

  sendMessageToWebview(message) {
    if (this._view) {
      this._view.webview.postMessage(message)
    }
  }

  async resolveCommentById(commentId, resolved) {
    if (!this.currentSpecRoot) return

    try {
      const userName = this.config.userName
      const userId = this.config.userId
      const allComments = this.commentManager.getAllComments(this.currentSpecRoot)
      const comment = allComments.find(c => c.commentId === commentId)

      if (!comment) return

      // Warn when modifying another author's comment
      if (comment.authorId !== userId) {
        const action = resolved ? 'Resolve' : 'Unresolve'
        const confirm = await vscode.window.showWarningMessage(
          `${action} comment by ${comment.authorName}?`,
          { modal: true, detail: 'Modifying another author\'s comment may cause merge conflicts.' },
          action
        )
        if (confirm !== action) return
      }

      // Check for unresolved child comments when marking as resolved
      if (resolved) {
        const allReplies = this.getAllReplies(comment.commentId, allComments)
        const unresolvedReplies = allReplies.filter(r => !r.resolved)

        if (unresolvedReplies.length > 0) {
          const ownUnresolved = unresolvedReplies.filter(r => r.authorId === userId)

          let message = `This comment has ${unresolvedReplies.length} unresolved ${unresolvedReplies.length === 1 ? 'reply' : 'replies'}.`
          if (ownUnresolved.length > 0) {
            message += ` Resolve your ${ownUnresolved.length} ${ownUnresolved.length === 1 ? 'reply' : 'replies'} too?`
          }

          const options = ownUnresolved.length > 0 ? ['Yes', 'No', 'Cancel'] : ['OK', 'Cancel']
          const result = await vscode.window.showInformationMessage(message, { modal: true }, ...options)

          if (result === 'Cancel') return

          if (result === 'Yes' && ownUnresolved.length > 0) {
            for (const reply of ownUnresolved) {
              await this.commentManager.resolveComment(
                reply.commentId,
                this.currentSpecRoot,
                true,
                userName
              )
            }
          }
        }
      }

      await this.commentManager.resolveComment(
        commentId,
        this.currentSpecRoot,
        resolved,
        resolved ? userName : null
      )

      // Reload the current comment from disk to get fresh data
      const updatedComments = this.commentManager.getAllComments(this.currentSpecRoot)
      const updatedCurrent = updatedComments.find(c => c.commentId === this.currentComment.commentId)
      if (updatedCurrent) {
        this.currentComment = updatedCurrent
      }

      // Refresh the detail view with updated data
      this.updateView()

      vscode.window.showInformationMessage(resolved ? 'Comment resolved' : 'Comment reopened')
      vscode.commands.executeCommand('specpress.refreshCommentTree')
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to update: ${e.message}`)
    }
  }

  async deleteCommentById(commentId) {
    if (!this.currentSpecRoot) return

    const allComments = this.commentManager.getAllComments(this.currentSpecRoot)
    const comment = allComments.find(c => c.commentId === commentId)
    if (!comment) return

    const confirm = await vscode.window.showWarningMessage(
      `Delete comment by ${comment.authorName}?`,
      { modal: true, detail: 'This action cannot be undone.' },
      'Delete'
    )

    if (confirm !== 'Delete') return

    try {
      const commentPath = path.join(
        this.commentManager.getCommentFolder(this.currentSpecRoot),
        commentId
      )
      fs.unlinkSync(commentPath)

      // Invalidate cache after delete
      this.commentManager.invalidateCache(this.currentSpecRoot)

      vscode.window.showInformationMessage('Comment deleted')

      // If we deleted the current parent, clear the view
      if (this.currentComment && this.currentComment.commentId === commentId) {
        this.currentComment = null
        this.currentSpecRoot = null
      }

      this.updateView()
      vscode.commands.executeCommand('specpress.refreshCommentTree')
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to delete: ${e.message}`)
    }
  }

  async openCommentJsonById(commentId) {
    if (!this.currentSpecRoot) return

    try {
      const commentPath = path.join(
        this.commentManager.getCommentFolder(this.currentSpecRoot),
        commentId
      )

      if (!fs.existsSync(commentPath)) {
        vscode.window.showErrorMessage(`Comment file not found`)
        return
      }

      const doc = await vscode.workspace.openTextDocument(commentPath)
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside)
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to open JSON file: ${e.message}`)
    }
  }

  async reconfirmCommentPosition(commentId) {
    if (!this.currentSpecRoot) return

    const allComments = this.commentManager.getAllComments(this.currentSpecRoot)
    const comment = allComments.find(c => c.commentId === commentId)
    if (!comment) return

    // Trigger the reconfirm command which will show the UI
    vscode.commands.executeCommand('specpress.reconfirmCommentPosition', comment, this.currentSpecRoot)
  }

  async handleReplyToParent(parentCommentId) {
    if (!this.currentComment || !this.currentSpecRoot) return

    const allComments = this.commentManager.getAllComments(this.currentSpecRoot)
    const parentComment = allComments.find(c => c.commentId === parentCommentId)
    if (!parentComment) return

    const replyText = await vscode.window.showInputBox({
      prompt: `Reply to ${parentComment.authorName}'s comment`,
      placeHolder: 'Type your reply here...',
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Reply text cannot be empty'
        }
        return null
      }
    })

    if (!replyText) return

    try {
      await this.commentManager.createReply(
        parentCommentId,
        parentComment.fileUri,
        parentComment.lineNumber,
        parentComment.columnNumber,
        parentComment.lineSnippet,
        replyText,
        this.currentSpecRoot
      )

      vscode.window.showInformationMessage('Reply added')
      this.updateView()
      vscode.commands.executeCommand('specpress.refreshCommentTree')
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to add reply: ${e.message}`)
    }
  }

  getEmptyStateHtml() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      padding: 20px;
      text-align: center;
    }
    .empty-state {
      margin-top: 50px;
      color: var(--vscode-descriptionForeground);
    }
    .icon {
      font-size: 48px;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="empty-state">
    <div class="icon">💬</div>
    <p>Select a comment from the tree above to view details</p>
  </div>
</body>
</html>`
  }

  getCommentHtml(comment) {
    // Get all replies for this parent comment (including nested replies)
    // Use single call to getAllComments and reuse throughout rendering
    const allComments = this.commentManager.getAllComments(this.currentSpecRoot)
    const replies = this.buildReplyTree(comment.commentId, allComments)

    const MarkdownIt = require('markdown-it')
    const md = new MarkdownIt()

    // Extract context around column position
    let contextSnippet = comment.lineSnippet || ''
    if (comment.columnNumber !== undefined && comment.lineSnippet) {
      const col = comment.columnNumber
      const start = Math.max(0, col - 20)
      const end = Math.min(comment.lineSnippet.length, col + 20)
      const before = comment.lineSnippet.substring(start, col)
      const after = comment.lineSnippet.substring(col, end)
      contextSnippet = (start > 0 ? '...' : '') + before + '|' + after + (end < comment.lineSnippet.length ? '...' : '')
    }

    // Build HTML for parent comment
    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 12px;
      line-height: 1.5;
    }
    .location {
      font-size: 0.85em;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
    }
    .comment-block {
      margin-bottom: 16px;
      border-left: 3px solid #e74c3c;
      padding-left: 12px;
    }
    .comment-block.resolved {
      border-left-color: #27ae60;
    }
    .comment-block.resolved-with-unresolved {
      border-left-color: #fbc02d;
    }
    .comment-header {
      font-size: 0.85em;
      color: var(--vscode-foreground);
      margin-bottom: 8px;
      font-weight: 500;
    }
    .comment-header .status-icon {
      font-weight: bold;
    }
    .comment-content {
      background-color: var(--vscode-textBlockQuote-background);
      padding: 10px;
      margin: 8px 0;
      font-size: 0.9em;
      cursor: pointer;
    }
    .comment-content:hover {
      background-color: var(--vscode-list-hoverBackground);
      outline: 1px solid var(--vscode-focusBorder);
    }
    .comment-content.editing {
      cursor: default;
      background-color: var(--vscode-input-background);
      padding: 0;
    }
    .comment-content.editing:hover {
      background-color: var(--vscode-input-background);
      outline: none;
    }
    .edit-textarea {
      width: 100%;
      min-height: 100px;
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: 0.9em;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      resize: vertical;
    }
    .edit-textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .edit-buttons {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .edit-toolbar {
      display: flex;
      gap: 2px;
      margin-bottom: 4px;
    }
    .edit-toolbar .toolbar-btn {
      padding: 2px 6px;
      font-size: 11px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-secondaryBackground, #333);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 2px;
      font-weight: bold;
    }
    .edit-toolbar .toolbar-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground, #444);
    }
    .comment-content p:first-child { margin-top: 0; }
    .comment-content p:last-child { margin-bottom: 0; }
    .buttons {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    button {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 0.8em;
    }
    button:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
    button.primary {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    code {
      background-color: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      font-size: 0.85em;
    }
  </style>
</head>
<body>
  <div class="location">
    📍 Line ${comment.lineNumber + 1}, Col ${comment.columnNumber !== undefined ? comment.columnNumber : 0} — <code>${this.escapeHtml(contextSnippet)}</code>
  </div>
`

    // Parent comment
    html += this.renderCommentBlock(comment, md, 0, allComments)

    // Replies (nested)
    html += this.renderReplies(replies, md, 1, allComments)

    html += `
  <script>
    const vscode = acquireVsCodeApi();
    let editingCommentId = null;
    let originalText = '';
    
    // Attach double-click listeners after DOM is loaded
    document.addEventListener('DOMContentLoaded', function() {
      const contentDivs = document.querySelectorAll('.comment-content');
      contentDivs.forEach(function(div) {
        div.addEventListener('dblclick', function() {
          const commentId = div.id.replace('content-', '');
          startEdit(commentId);
        });
      });
    });
    
    function resolveComment(commentId, resolved) {
      vscode.postMessage({ type: 'resolve', commentId, resolved });
    }
    
    function replyToComment(commentId) {
      vscode.postMessage({ type: 'reply', parentCommentId: commentId });
    }
    
    function reconfirmPosition(commentId) {
      vscode.postMessage({ type: 'reconfirmPosition', commentId });
    }
    
    function openJson(commentId) {
      vscode.postMessage({ type: 'openJson', commentId });
    }
    
    function deleteComment(commentId) {
      vscode.postMessage({ type: 'delete', commentId });
    }
    
    function startEdit(commentId) {
      if (editingCommentId) return; // Already editing another comment
      
      editingCommentId = commentId;
      const contentDiv = document.getElementById('content-' + commentId);
      const buttonsDiv = document.getElementById('buttons-' + commentId);
      const block = document.querySelector('[data-comment-id="' + commentId + '"]');
      
      // Store original HTML for restoration
      block.setAttribute('data-rendered-html', contentDiv.innerHTML);
      block.setAttribute('data-buttons-html', buttonsDiv.innerHTML);
      
      // Get original text from the block's data attribute
      originalText = block.getAttribute('data-original-text');
      
      // Replace content with toolbar + textarea
      contentDiv.className = 'comment-content editing';
      contentDiv.innerHTML = '';
      
      // Create toolbar
      const toolbar = document.createElement('div');
      toolbar.className = 'edit-toolbar';
      const BT = String.fromCharCode(96);
      [['B', '**', '**'], ['I', '*', '*'], ['Code', BT, BT], ['\\n', '\\n', '']].forEach(function(item) {
        const btn = document.createElement('button');
        btn.className = 'toolbar-btn';
        btn.textContent = item[0];
        btn.title = item[0] === 'B' ? 'Bold' : item[0] === 'I' ? 'Italic' : item[0] === 'Code' ? 'Inline code' : 'Line break';
        btn.dataset.before = item[1];
        btn.dataset.after = item[2];
        toolbar.appendChild(btn);
      });
      contentDiv.appendChild(toolbar);
      
      // Create textarea
      const textarea = document.createElement('textarea');
      textarea.className = 'edit-textarea';
      textarea.id = 'edit-textarea-' + commentId;
      textarea.value = originalText;
      contentDiv.appendChild(textarea);
      
      // Attach toolbar button handlers
      toolbar.querySelectorAll('.toolbar-btn').forEach(function(btn) {
        btn.addEventListener('mousedown', function(e) {
          e.preventDefault();
          insertAround(textarea, btn.dataset.before, btn.dataset.after);
        });
      });
      
      // Replace buttons with edit controls
      const saveBtn = document.createElement('button');
      saveBtn.className = 'primary';
      saveBtn.textContent = '✔ Save';
      saveBtn.onclick = function() { saveEdit(commentId); };
      
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '✖ Cancel';
      cancelBtn.onclick = function() { cancelEdit(commentId); };
      
      const editButtonsDiv = document.createElement('div');
      editButtonsDiv.className = 'edit-buttons';
      editButtonsDiv.appendChild(saveBtn);
      editButtonsDiv.appendChild(cancelBtn);
      
      buttonsDiv.innerHTML = '';
      buttonsDiv.appendChild(editButtonsDiv);
      
      // Focus textarea
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
    
    function insertAround(textarea, before, after) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      const selected = text.substring(start, end);
      textarea.value = text.substring(0, start) + before + selected + after + text.substring(end);
      textarea.selectionStart = start + before.length;
      textarea.selectionEnd = start + before.length + selected.length;
      textarea.focus();
    }
    
    function saveEdit(commentId) {
      const textarea = document.getElementById('edit-textarea-' + commentId);
      if (!textarea) {
        console.error('Textarea not found for comment:', commentId);
        restoreView(commentId);
        return;
      }
      const newText = textarea.value;
      editingCommentId = null;
      vscode.postMessage({ type: 'saveEdit', commentId, newText });
    }
    
    function cancelEdit(commentId) {
      editingCommentId = null;
      restoreView(commentId);
    }
    
    function restoreView(commentId) {
      const contentDiv = document.getElementById('content-' + commentId);
      const buttonsDiv = document.getElementById('buttons-' + commentId);
      const block = document.querySelector('[data-comment-id="' + commentId + '"]');
      
      if (!contentDiv || !buttonsDiv || !block) return;
      
      // Restore original content
      contentDiv.className = 'comment-content';
      contentDiv.innerHTML = block.getAttribute('data-rendered-html');
      
      // Restore original buttons
      buttonsDiv.innerHTML = block.getAttribute('data-buttons-html');
    }
  </script>
</body>
</html>`

    return html
  }

  buildReplyTree(parentId, allComments) {
    const directReplies = allComments.filter(c => c.replyTo === parentId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    return directReplies.map(reply => ({
      comment: reply,
      replies: this.buildReplyTree(reply.commentId, allComments)
    }))
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

  renderReplies(replyTree, md, depth, allComments) {
    let html = ''
    for (const node of replyTree) {
      html += this.renderCommentBlock(node.comment, md, depth, allComments)
      if (node.replies.length > 0) {
        html += this.renderReplies(node.replies, md, depth + 1, allComments)
      }
    }
    return html
  }

  renderCommentBlock(comment, md, depth, allComments) {
    const hasReplies = allComments.some(c => c.replyTo === comment.commentId)
    const allReplies = this.getAllReplies(comment.commentId, allComments)
    const hasUnresolvedReplies = allReplies.some(r => !r.resolved)

    // Determine icon and CSS class - consistent with tree and hover
    let resolvedIcon = '<span style="color: #ff1100;">❗</span>' // Red exclamation for unresolved
    let cssClass = ''
    if (comment.resolved) {
      if (hasUnresolvedReplies) {
        resolvedIcon = '<span style="color: #fbc02d;">✓</span>' // Yellow checkmark for resolved with unresolved replies
        cssClass = ' resolved-with-unresolved'
      } else {
        resolvedIcon = '<span style="color: #2dcd32;">✅</span>' // Green check for fully resolved
        cssClass = ' resolved'
      }
    }

    const createdDate = new Date(comment.createdAt).toLocaleString()
    const renderedText = md.render(comment.commentText)
    const marginLeft = depth * 20
    const escapedForAttr = this.escapeForAttribute(comment.commentText)

    return `
  <div class="comment-block${cssClass}" style="margin-left: ${marginLeft}px;" data-comment-id="${comment.commentId}" data-original-text="${escapedForAttr}">
    <div class="comment-header">
      <span class="status-icon">${resolvedIcon}</span> <strong>${comment.authorName}</strong> — ${createdDate}
    </div>
    <div class="comment-content" id="content-${comment.commentId}" title="Double-click to edit">
      ${renderedText}
    </div>
    <div class="buttons" id="buttons-${comment.commentId}">
      ${comment.resolved ? `
        <button onclick="resolveComment('${comment.commentId}', false)">🔄 Unresolve</button>
      ` : `
        <button class="primary" onclick="resolveComment('${comment.commentId}', true)">✅ Resolve</button>
      `}
      <button onclick="replyToComment('${comment.commentId}')">↩️ Reply</button>
      ${!comment.replyTo ? `<button onclick="reconfirmPosition('${comment.commentId}')">📍 Reconfirm Position</button>` : ''}
      <button onclick="openJson('${comment.commentId}')">📄 JSON</button>
      ${!hasReplies ? `<button onclick="deleteComment('${comment.commentId}')">🗑️ Delete</button>` : ''}
    </div>
  </div>
`
  }

  escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  escapeForAttribute(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/\n/g, '&#10;')
      .replace(/\r/g, '&#13;')
  }
}

module.exports = { CommentDetailViewProvider }
