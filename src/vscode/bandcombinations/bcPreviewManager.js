const vscode = require('vscode')
const path = require('path')
const fs = require('fs')

class BcPreviewManager {
  constructor(state, config) {
    this.state = state
    this.config = config
    this.panel = null
    this.currentFilePath = null
    this.disposables = []
    this.multiMode = false
    this.multiBcFiles = []
  }

  async openPreview(filePath) {
    this.currentFilePath = filePath
    this.multiMode = false
    this.multiBcFiles = []

    // First, open the JSON file in the editor
    const doc = await vscode.workspace.openTextDocument(filePath)
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One)

    if (!this.panel) {
      const resourceRoot = path.dirname(filePath)
      this.panel = vscode.window.createWebviewPanel(
        'specpressBcPreview',
        'BC Preview',
        vscode.ViewColumn.Two,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(resourceRoot)]
        }
      )

      this.panel.onDidDispose(() => {
        this.panel = null
        this.currentFilePath = null
        this.disposeListeners()
      })
    } else {
      this.panel.reveal(vscode.ViewColumn.Two)
    }

    await this.updatePreview(filePath)
    this.setupLiveUpdate()
  }

  async openMultiPreview(bcFiles) {
    const limitedFiles = bcFiles.slice(0, 100)
    this.multiMode = true
    this.multiBcFiles = limitedFiles
    this.currentFilePath = null

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'specpressBcPreview',
        'BC Preview',
        vscode.ViewColumn.Two,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      )

      this.panel.onDidDispose(() => {
        this.panel = null
        this.currentFilePath = null
        this.multiMode = false
        this.multiBcFiles = []
        this.disposeListeners()
      })
    } else {
      this.panel.reveal(vscode.ViewColumn.Two)
    }

    await this.updateMultiPreview()
  }

  async updatePreview(filePath) {
    if (!this.panel) return

    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const data = JSON.parse(content)
      
      this.panel.title = `BC Preview: ${data.bcId || path.basename(filePath)}`
      
      // Use jsvalidator to render HTML (without header)
      const html = await this.renderBcAsHtml(data, path.basename(filePath), false)
      this.panel.webview.html = html
    } catch (e) {
      this.panel.webview.html = this.buildErrorHtml(e.message)
    }
  }

  async updateMultiPreview() {
    if (!this.panel) return

    try {
      this.panel.title = `BC Preview (${this.multiBcFiles.length} entries)`
      const html = await this.renderMultiBcAsHtml(this.multiBcFiles)
      this.panel.webview.html = html
    } catch (e) {
      this.panel.webview.html = this.buildErrorHtml(e.message)
    }
  }

  async renderMultiBcAsHtml(bcFiles) {
    try {
      const { BC, BandCombinationList } = await import('ran4-jsvalidator/src/BandCombinations.js')
      const { HtmlTable } = await import('ran4-jsvalidator/src/HtmlTable.js')
      const { BC_ID } = await import('ran4-jsvalidator/src/BC_ID.js')
      
      // Sort bcFiles using BC_ID comparison (same as tree view)
      const sortedFiles = bcFiles.slice().sort((a, b) => {
        try {
          const bcIdA = new BC_ID(a.bcId)
          const bcIdB = new BC_ID(b.bcId)
          
          if (bcIdA.lessThan(bcIdB)) return -1
          if (bcIdA.greaterThan(bcIdB)) return 1
          return 0
        } catch (e) {
          return a.bcId.localeCompare(b.bcId)
        }
      })
      
      const htmlTable = new HtmlTable()
      BandCombinationList.addTableHeaders(htmlTable)
      
      for (const bcFile of sortedFiles) {
        try {
          const content = fs.readFileSync(bcFile.path, 'utf8')
          const data = JSON.parse(content)
          const bc = new BC(data)
          bc.toHTML(htmlTable)
        } catch (e) {
          // Skip invalid BC files
        }
      }
      
      const tableHtml = this.htmlTableToString(htmlTable)
      return this.wrapInSimpleHtml(`Multiple Band Combinations (${bcFiles.length})`, tableHtml)
    } catch (e) {
      return this.buildErrorHtml(e.message)
    }
  }

  async renderBcAsHtml(data, filename, includeHeader = true) {
    try {
      // Dynamically import jsvalidator ESM modules
      const { BC, BandCombinationList } = await import('ran4-jsvalidator/src/BandCombinations.js')
      const { HtmlTable } = await import('ran4-jsvalidator/src/HtmlTable.js')
      
      // Create BC instance and render to HtmlTable
      const bc = new BC(data)
      const htmlTable = new HtmlTable()
      
      // Add header row using jsvalidator's standard headers
      BandCombinationList.addTableHeaders(htmlTable)
      
      bc.toHTML(htmlTable)
      
      // Generate HTML from HtmlTable
      const tableHtml = this.htmlTableToString(htmlTable)
      
      if (includeHeader) {
        return this.wrapInHtml(data.bcId || 'Unknown', filename, data.bcsId, tableHtml)
      } else {
        return this.wrapInSimpleHtml(data.bcId || 'Unknown', tableHtml)
      }
    } catch (e) {
      // Fallback to simple rendering if jsvalidator fails
      return this.buildFallbackHtml(data, filename, e.message)
    }
  }

  htmlTableToString(htmlTable) {
    const indent = '  '
    const lines = []
    
    lines.push('<table>')
    for (let rowIndex = 0; rowIndex < htmlTable.getNrofRows(); rowIndex++) {
      lines.push(`${indent}<tr>`)
      for (let colIndex = 0; colIndex < htmlTable.getNrofColumns(); colIndex++) {
        const value = htmlTable.getValue(rowIndex, colIndex)
        if (value !== null) {
          if (rowIndex === 0) {
            // Header row
            lines.push(`${indent}${indent}<th>${this.escapeHtml(value)}</th>`)
          } else if (value !== '' || rowIndex === 1) {
            // Check for rowspan
            let rowspan = 1
            let row = rowIndex + 1
            while (row < htmlTable.getNrofRows() && htmlTable.getValue(row, colIndex) === '') {
              rowspan++
              row++
            }
            const rowspanAttr = rowspan > 1 ? ` rowspan="${rowspan}"` : ''
            
            // Don't escape &nbsp; - render it as HTML entity (or empty)
            const cellContent = value === '&nbsp;' ? '' : this.escapeHtml(value)
            lines.push(`${indent}${indent}<td${rowspanAttr}>${cellContent}</td>`)
          }
        }
      }
      lines.push(`${indent}</tr>`)
    }
    lines.push('</table>')
    
    return lines.join('\n')
  }

  wrapInSimpleHtml(title, tableHtml) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    h1 {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 10px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 20px 0;
    }
    th, td {
      border: 1px solid var(--vscode-panel-border);
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-weight: bold;
      position: sticky;
      top: 0;
    }
  </style>
</head>
<body>
  <h1>${this.escapeHtml(title)}</h1>
  ${tableHtml}
</body>
</html>`
  }

  wrapInHtml(bcId, filename, bcsId, tableHtml) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    h1 {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 10px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 20px 0;
    }
    th, td {
      border: 1px solid var(--vscode-panel-border);
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-weight: bold;
    }
    .info {
      margin: 10px 0;
    }
    .label {
      font-weight: bold;
      display: inline-block;
      min-width: 120px;
    }
  </style>
</head>
<body>
  <h1>Band Combination: ${this.escapeHtml(bcId)}</h1>
  
  <div class="info">
    <div><span class="label">File:</span> ${this.escapeHtml(filename)}</div>
    ${bcsId ? `<div><span class="label">BCS ID:</span> ${this.escapeHtml(bcsId)}</div>` : ''}
  </div>

  <h2>Band Combination Table</h2>
  ${tableHtml}
</body>
</html>`
  }

  buildFallbackHtml(data, filename, errorMsg) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    h1 {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 10px;
    }
    .error {
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 10px;
      margin: 10px 0;
    }
    pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <h1>Band Combination: ${this.escapeHtml(data.bcId || 'Unknown')}</h1>
  
  <div class="error">
    <strong>HTML rendering failed:</strong> ${this.escapeHtml(errorMsg)}
  </div>

  <h2>Raw JSON</h2>
  <pre>${this.escapeHtml(JSON.stringify(data, null, 2))}</pre>
</body>
</html>`
  }

  buildErrorHtml(message) {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-errorForeground);
      padding: 20px;
    }
  </style>
</head>
<body>
  <h2>Error loading Band Combination</h2>
  <pre>${this.escapeHtml(message)}</pre>
</body>
</html>`
  }

  escapeHtml(str) {
    if (typeof str !== 'string') return ''
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  setupLiveUpdate() {
    this.disposeListeners()

    // Find the editor showing this file
    const editor = vscode.window.visibleTextEditors.find(
      e => e.document.uri.fsPath === this.currentFilePath
    )

    if (!editor) return

    // Live update on text changes (debounced) - only in single file mode
    let updateTimeout = null
    const listener = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document === editor.document && this.panel && !this.multiMode) {
        if (updateTimeout) clearTimeout(updateTimeout)
        updateTimeout = setTimeout(async () => {
          if (!this.panel) return
          await this.updatePreview(this.currentFilePath)
        }, 500)
      }
    })

    this.disposables.push(listener)
  }

  disposeListeners() {
    this.disposables.forEach(d => d.dispose())
    this.disposables = []
  }

  dispose() {
    if (this.panel) {
      this.panel.dispose()
      this.panel = null
    }
    this.disposeListeners()
  }
}

module.exports = { BcPreviewManager }
