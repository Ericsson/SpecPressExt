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

    // Open the JSON file in the editor
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

      // Handle messages from webview
      this.panel.webview.onDidReceiveMessage(async message => {
        if (message.command === 'openRef') {
          await this.openReferencedFile(message.ref, message.bcs)
        }
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

      this.panel.title = `BC Preview: ${data.bcId || data.bandNumber || path.basename(filePath)}`

      // Use 38.101 validator to render HTML (without header)
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
      const groups = [
        { files: bcFiles.filter(f => f.isBand), title: 'Frequency Bands', sortKey: 'BandNumber' },
        { files: bcFiles.filter(f => f.isCA), title: 'Carrier Aggregation', sortKey: 'BC_ID' },
        { files: bcFiles.filter(f => f.isDC), title: 'Dual Connectivity', sortKey: 'BC_ID' }
      ]

      let html = ''

      for (const group of groups) {
        if (group.files.length === 0) continue

        const sorted = await this.sortBcFilesByType(group.files, group.sortKey)
        const sections = []

        for (const file of sorted) {
          try {
            const data = JSON.parse(fs.readFileSync(file.path, 'utf8'))
            const tableHtml = await this.renderSingleBcTable(data)
            sections.push(tableHtml)
          } catch (e) {}
        }

        if (sections.length > 0) {
          html += `<h2>${group.title} (${group.files.length})</h2>\n${this.mergeTables(sections)}\n`
        }
      }

      return this.wrapInSimpleHtml(`Preview (${bcFiles.length} entries)`, html)
    } catch (e) {
      return this.buildErrorHtml(e.message)
    }
  }

  async sortBcFilesByType(files, sortKey) {
    if (sortKey === 'BandNumber') {
      const { BandNumber } = await import('specpress/lib/ran4/BandNumber.js')
      return files.slice().sort((a, b) => {
        try {
          return new BandNumber(a.bcId).asInt() - new BandNumber(b.bcId).asInt()
        } catch (e) {
          return a.bcId.localeCompare(b.bcId)
        }
      })
    }

    const { BC_ID } = await import('specpress/lib/ran4/BC_ID.js')
    return files.slice().sort((a, b) => {
      try {
        const idA = new BC_ID(a.bcId)
        const idB = new BC_ID(b.bcId)
        if (idA.lessThan(idB)) return -1
        if (idA.greaterThan(idB)) return 1
        return 0
      } catch (e) {
        return a.bcId.localeCompare(b.bcId)
      }
    })
  }

  async renderSingleBcTable(data) {
    if (data.bandNumber) {
      const { ChannelBandwidthList } = await import('specpress/lib/ran4/ChannelBandwidthPerBand.js')
      return ChannelBandwidthList.renderAsHtml(data)
    } else if (data.ulConfigList) {
      const { DcBandCombinationList } = await import('specpress/lib/ran4/DualConnectivity.js')
      return DcBandCombinationList.renderAsHtml(data)
    } else {
      const { ulNoteDescriptions, dlNoteDescriptions } = await this.loadNoteDescriptions(data)
      const { BandCombinationList } = await import('specpress/lib/ran4/BandCombinations.js')
      return BandCombinationList.renderAsHtml(data, ulNoteDescriptions, dlNoteDescriptions)
    }
  }

  mergeTables(tableHtmlArray) {
    if (tableHtmlArray.length === 0) return ''

    // Extract header from first table
    const firstTable = tableHtmlArray[0]
    const headerMatch = firstTable.match(/<tr>\s*<th>.*?<\/tr>/s)
    const header = headerMatch ? headerMatch[0] : ''

    // Extract all data rows (skip headers)
    const allRows = tableHtmlArray.map(html => {
      return html.replace(/<table>/, '').replace(/<\/table>/, '').replace(/<tr>\s*<th>.*?<\/tr>/s, '')
    }).join('')

    return `<table>\n${header}${allRows}</table>\n`
  }

  async renderBcAsHtml(data, filename, includeHeader = true) {
    try {
      let tableHtml
      if (data.bandNumber) {
        const { ChannelBandwidthList } = await import('specpress/lib/ran4/ChannelBandwidthPerBand.js')
        tableHtml = ChannelBandwidthList.renderAsHtml(data)
      } else if (data.ulConfigList) {
        const { DcBandCombinationList } = await import('specpress/lib/ran4/DualConnectivity.js')
        tableHtml = DcBandCombinationList.renderAsHtml(data)
      } else {
        const { ulNoteDescriptions, dlNoteDescriptions } = await this.loadNoteDescriptions(data)
        const { BandCombinationList } = await import('specpress/lib/ran4/BandCombinations.js')
        tableHtml = BandCombinationList.renderAsHtml(data, ulNoteDescriptions, dlNoteDescriptions)
      }

      if (includeHeader) {
        return this.wrapInHtml(data.bcId || data.bandNumber || 'Unknown', filename, data.bcsId, tableHtml)
      } else {
        return this.wrapInSimpleHtml(data.bcId || data.bandNumber || 'Unknown', tableHtml)
      }
    } catch (e) {
      return this.buildFallbackHtml(data, filename, e.message)
    }
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
    sup {
      font-size: 0.7em;
      color: var(--vscode-textLink-foreground);
      cursor: help;
      text-decoration: none;
    }
    a.bc-ref-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
    }
    a.bc-ref-link:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <h1>${this.escapeHtml(title)}</h1>
  ${tableHtml}
  <script>
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('bc-ref-link')) {
        e.preventDefault();
        const ref = e.target.getAttribute('data-ref');
        const bcs = e.target.getAttribute('data-bcs');
        vscode.postMessage({ command: 'openRef', ref, bcs });
      }
    });
  </script>
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

  async openReferencedFile(ref, bcs) {
    // ref is either a band number (e.g., "n3") or BC-ID (e.g., "CA_n3B")
    // bcs is the BCS-ID if applicable (or null)

    const bcFolder = this.config.raw.get('bandCombinationFolder', '')
    if (!bcFolder) return

    const absFolder = path.isAbsolute(bcFolder)
      ? bcFolder
      : this.config.wsRoot ? path.join(this.config.wsRoot, bcFolder) : bcFolder

    if (!fs.existsSync(absFolder)) return

    // Determine filename
    let filename
    if (ref.startsWith('n') && !ref.includes('_')) {
      // Band number: n3.json
      filename = `${ref}.json`
    } else {
      // BC-ID: CA_n3B.json or DC_n3B-n78C.json
      filename = `${ref}.json`
    }

    // Search for the file recursively
    const filePath = this.findFileRecursive(absFolder, filename)

    if (filePath) {
      // Open via the command to get both editor and preview
      await vscode.commands.executeCommand('specpress.openBcPreview', filePath)
    } else {
      vscode.window.showWarningMessage(`Referenced file not found: ${filename}`)
    }
  }

  async loadNoteDescriptions(bcData) {
    const ulNoteDescriptions = {}
    const dlNoteDescriptions = {}

    try {
      const bcFolder = this.config.raw.get('bandCombinationFolder', '')
      if (!bcFolder) return { ulNoteDescriptions, dlNoteDescriptions }

      const absFolder = path.isAbsolute(bcFolder)
        ? bcFolder
        : this.config.wsRoot ? path.join(this.config.wsRoot, bcFolder) : bcFolder

      // Determine schema file based on BC type (CA vs DC)
      const isDC = bcData.bcId && bcData.bcId.startsWith('DC_')
      const schemaFileName = isDC
        ? 'BandCombinationsDualConnectivity.json'
        : 'BandCombinationsCarrierAggregation.json'

      // Schema files are typically in common/jsonSchemas folder relative to BC folder
      const schemaPath = path.join(absFolder, 'common', 'jsonSchemas', schemaFileName)

      if (fs.existsSync(schemaPath)) {
        const schemaContent = fs.readFileSync(schemaPath, 'utf8')
        const schema = JSON.parse(schemaContent)

        // Extract UL note descriptions
        const ulConfigSchema = isDC
          ? schema.properties?.ulConfigList?.items?.properties?.notes?.properties
          : schema.properties?.bcsList?.items?.properties?.ulConfigList?.items?.properties?.notes?.properties

        if (ulConfigSchema) {
          for (const [key, value] of Object.entries(ulConfigSchema)) {
            if (value.description) {
              ulNoteDescriptions[key] = value.description
            }
          }
        }

        // Extract DL (BC-level) note descriptions
        const dlNotesSchema = schema.properties?.notes?.properties
        if (dlNotesSchema) {
          for (const [key, value] of Object.entries(dlNotesSchema)) {
            if (value.description) {
              dlNoteDescriptions[key] = value.description
            }
          }
        }
      }
    } catch (e) {
      // Silently fall back to empty descriptions
    }

    return { ulNoteDescriptions, dlNoteDescriptions }
  }

  findFileRecursive(dir, filename) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isFile() && entry.name === filename) {
          return fullPath
        }

        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          const found = this.findFileRecursive(fullPath, filename)
          if (found) return found
        }
      }
    } catch (e) {
      // Skip inaccessible directories
    }

    return null
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
