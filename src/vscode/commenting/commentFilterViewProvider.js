const vscode = require('vscode')

/**
 * Webview provider for comment filter inputs
 */
class CommentFilterViewProvider {
  constructor(commentTreeProvider) {
    this.commentTreeProvider = commentTreeProvider
    this._view = null
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView

    webviewView.webview.options = {
      enableScripts: true
    }

    webviewView.webview.onDidReceiveMessage(message => {
      if (message.type === 'filter') {
        this.commentTreeProvider.setFilters(message.text, message.author, message.unresolvedOnly)
      }
    })

    this.updateView()
  }

  updateView() {
    if (!this._view) return
    this._view.webview.html = this.getHtml()
  }

  getHtml() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 8px;
    }
    .filter-group {
      margin-bottom: 8px;
    }
    label {
      display: block;
      font-size: 0.85em;
      margin-bottom: 3px;
      color: var(--vscode-descriptionForeground);
    }
    input[type="text"] {
      width: 100%;
      padding: 4px 6px;
      font-family: var(--vscode-font-family);
      font-size: 0.9em;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      box-sizing: border-box;
    }
    input[type="text"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
    }
    .checkbox-group input[type="checkbox"] {
      margin: 0;
    }
    .checkbox-group label {
      margin: 0;
      cursor: pointer;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <div class="filter-group">
    <label for="filterText">Filter by comment text:</label>
    <input type="text" id="filterText" placeholder="Search in comments...">
  </div>
  <div class="filter-group">
    <label for="filterAuthor">Filter by author ID:</label>
    <input type="text" id="filterAuthor" placeholder="Author ID...">
  </div>
  <div class="checkbox-group">
    <input type="checkbox" id="unresolvedOnly">
    <label for="unresolvedOnly">Unresolved only</label>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const filterText = document.getElementById('filterText');
    const filterAuthor = document.getElementById('filterAuthor');
    const unresolvedOnly = document.getElementById('unresolvedOnly');

    let timeout = null;

    function sendFilter() {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        vscode.postMessage({
          type: 'filter',
          text: filterText.value,
          author: filterAuthor.value,
          unresolvedOnly: unresolvedOnly.checked
        });
      }, 300);
    }

    filterText.addEventListener('input', sendFilter);
    filterAuthor.addEventListener('input', sendFilter);
    unresolvedOnly.addEventListener('change', sendFilter);
  </script>
</body>
</html>`
  }
}

module.exports = { CommentFilterViewProvider }
