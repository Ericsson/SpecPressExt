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
      // Separate bands, CA, and DC files
      const bandFiles = bcFiles.filter(f => f.isBand)
      const caFiles = bcFiles.filter(f => f.isCA)
      const dcFiles = bcFiles.filter(f => f.isDC)
      
      let html = ''
      
      // Render bands if any
      if (bandFiles.length > 0) {
        const { ChBwOneBand } = await import('ran4-jsvalidator/src/ChannelBandwidthPerBand.js')
        const { HtmlTable } = await import('ran4-jsvalidator/src/HtmlTable.js')
        const { BandNumber } = await import('ran4-jsvalidator/src/BandNumber.js')
        
        // Sort band files numerically
        const sortedBandFiles = bandFiles.slice().sort((a, b) => {
          try {
            const bandA = new BandNumber(a.bcId)
            const bandB = new BandNumber(b.bcId)
            return bandA.asInt() - bandB.asInt()
          } catch (e) {
            return a.bcId.localeCompare(b.bcId)
          }
        })
        
        const bandHtmlTable = new HtmlTable()
        bandHtmlTable.setValue(0, 0, 'Band')
        bandHtmlTable.setValue(0, 1, 'SCS [kHz]')
        bandHtmlTable.setValue(0, 2, 'Bandwidths [MHz]')
        
        for (const bandFile of sortedBandFiles) {
          try {
            const content = fs.readFileSync(bandFile.path, 'utf8')
            const data = JSON.parse(content)
            const band = new ChBwOneBand(data)
            band.toHTML(bandHtmlTable)
          } catch (e) {
            // Skip invalid band files
          }
        }
        
        const bandTableHtml = this.htmlTableToString(bandHtmlTable)
        html += `<h2>Frequency Bands (${bandFiles.length})</h2>\n${bandTableHtml}\n`
      }
      
      // Render CA files if any
      if (caFiles.length > 0) {
        const { BC, BandCombinationList } = await import('ran4-jsvalidator/src/BandCombinations.js')
        const { HtmlTable } = await import('ran4-jsvalidator/src/HtmlTable.js')
        const { BC_ID } = await import('ran4-jsvalidator/src/BC_ID.js')
        
        // Load note descriptions from first CA file
        const firstCa = caFiles[0]
        const firstContent = fs.readFileSync(firstCa.path, 'utf8')
        const firstData = JSON.parse(firstContent)
        const { ulNoteDescriptions, dlNoteDescriptions } = await this.loadNoteDescriptions(firstData)
        
        // Sort CA files using BC_ID comparison
        const sortedCaFiles = caFiles.slice().sort((a, b) => {
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
        
        const caHtmlTable = new HtmlTable()
        BandCombinationList.addTableHeaders(caHtmlTable)
        
        for (const caFile of sortedCaFiles) {
          try {
            const content = fs.readFileSync(caFile.path, 'utf8')
            const data = JSON.parse(content)
            const bc = new BC(data)
            bc.toHTML(caHtmlTable, 0, 0, ulNoteDescriptions, dlNoteDescriptions)
          } catch (e) {
            // Skip invalid CA files
          }
        }
        
        const caTableHtml = this.htmlTableToString(caHtmlTable)
        html += `<h2>Carrier Aggregation (${caFiles.length})</h2>\n${caTableHtml}\n`
      }
      
      // Render DC files if any
      if (dcFiles.length > 0) {
        const { DualConnectivityConfig } = await import('ran4-jsvalidator/src/DualConnectivity.js')
        const { HtmlTable } = await import('ran4-jsvalidator/src/HtmlTable.js')
        const { BC_ID } = await import('ran4-jsvalidator/src/BC_ID.js')
        
        // Sort DC files using BC_ID comparison
        const sortedDcFiles = dcFiles.slice().sort((a, b) => {
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
        
        const dcHtmlTable = new HtmlTable()
        dcHtmlTable.setValue(0, 0, 'DL Configuration')
        dcHtmlTable.setValue(0, 1, 'UL Configurations')
        dcHtmlTable.setValue(0, 2, 'Single UL')
        dcHtmlTable.setValue(0, 3, 'DL Interruptions')
        dcHtmlTable.setValue(0, 4, 'Notes')
        
        let row = 1
        for (const dcFile of sortedDcFiles) {
          try {
            const content = fs.readFileSync(dcFile.path, 'utf8')
            const data = JSON.parse(content)
            const dc = new DualConnectivityConfig(data, null, false, false)
            
            dcHtmlTable.setValue(row, 0, String(dc.bcId))
            const ulConfigs = dc.ulConfigList.map(ul => String(ul.bcId)).join('<br>')
            dcHtmlTable.setValue(row, 1, ulConfigs || '–')
            dcHtmlTable.setValue(row, 2, dc.singleUlAllowed || '–')
            dcHtmlTable.setValue(row, 3, dc.dlInterruptionsAllowed || '–')
            const noteKeys = Object.keys(dc.notes)
            const notesStr = noteKeys.length > 0 ? noteKeys.join(', ') : '–'
            dcHtmlTable.setValue(row, 4, notesStr)
            row++
          } catch (e) {
            // Skip invalid DC files
          }
        }
        
        const dcTableHtml = this.htmlTableToString(dcHtmlTable)
        html += `<h2>Dual Connectivity (${dcFiles.length})</h2>\n${dcTableHtml}\n`
      }
      
      const title = `Preview (${bcFiles.length} entries)`
      return this.wrapInSimpleHtml(title, html)
    } catch (e) {
      return this.buildErrorHtml(e.message)
    }
  }

  async renderDcAsHtml(data, filename, includeHeader = true) {
    try {
      const { DualConnectivityConfig } = await import('ran4-jsvalidator/src/DualConnectivity.js')
      const { HtmlTable } = await import('ran4-jsvalidator/src/HtmlTable.js')
      
      const dc = new DualConnectivityConfig(data, null, false, false)
      const htmlTable = new HtmlTable()
      
      // Add header row
      htmlTable.setValue(0, 0, 'DL Configuration')
      htmlTable.setValue(0, 1, 'UL Configurations')
      htmlTable.setValue(0, 2, 'Single UL')
      htmlTable.setValue(0, 3, 'DL Interruptions')
      htmlTable.setValue(0, 4, 'Notes')
      
      // Add DL configuration
      const row = 1
      htmlTable.setValue(row, 0, String(dc.bcId))
      
      // Add UL configurations
      const ulConfigs = dc.ulConfigList.map(ul => String(ul.bcId)).join('<br>')
      htmlTable.setValue(row, 1, ulConfigs || '–')
      
      // Add single UL allowed
      htmlTable.setValue(row, 2, dc.singleUlAllowed || '–')
      
      // Add DL interruptions allowed
      htmlTable.setValue(row, 3, dc.dlInterruptionsAllowed || '–')
      
      // Add notes
      const noteKeys = Object.keys(dc.notes)
      const notesStr = noteKeys.length > 0 ? noteKeys.join(', ') : '–'
      htmlTable.setValue(row, 4, notesStr)
      
      const tableHtml = this.htmlTableToString(htmlTable)
      
      if (includeHeader) {
        return this.wrapInHtml(data.bcId || 'Unknown', filename, null, tableHtml)
      } else {
        return this.wrapInSimpleHtml(data.bcId || 'Unknown', tableHtml)
      }
    } catch (e) {
      return this.buildFallbackHtml(data, filename, e.message)
    }
  }

  async renderBandAsHtml(data, filename, includeHeader = true) {
    try {
      const { ChBwOneBand, ChannelBandwidthList } = await import('ran4-jsvalidator/src/ChannelBandwidthPerBand.js')
      const { HtmlTable } = await import('ran4-jsvalidator/src/HtmlTable.js')
      
      const band = new ChBwOneBand(data)
      const htmlTable = new HtmlTable()
      
      // Add header row
      htmlTable.setValue(0, 0, 'Band')
      htmlTable.setValue(0, 1, 'SCS [kHz]')
      htmlTable.setValue(0, 2, 'Bandwidths [MHz]')
      
      band.toHTML(htmlTable)
      
      const tableHtml = this.htmlTableToString(htmlTable)
      
      if (includeHeader) {
        return this.wrapInHtml(data.bandNumber || 'Unknown', filename, null, tableHtml)
      } else {
        return this.wrapInSimpleHtml(data.bandNumber || 'Unknown', tableHtml)
      }
    } catch (e) {
      return this.buildFallbackHtml(data, filename, e.message)
    }
  }

  async renderBcAsHtml(data, filename, includeHeader = true) {
    try {
      // Check if this is a band file (has bandNumber), DC file (has ulConfigList), or CA file (has bcsList)
      if (data.bandNumber) {
        return await this.renderBandAsHtml(data, filename, includeHeader)
      }
      
      if (data.ulConfigList) {
        return await this.renderDcAsHtml(data, filename, includeHeader)
      }
      
      // Dynamically import jsvalidator ESM modules for CA
      const { BC, BandCombinationList } = await import('ran4-jsvalidator/src/BandCombinations.js')
      const { HtmlTable } = await import('ran4-jsvalidator/src/HtmlTable.js')
      
      // Load note descriptions from schema
      const { ulNoteDescriptions, dlNoteDescriptions } = await this.loadNoteDescriptions(data)
      
      // Create BC instance and render to HtmlTable
      const bc = new BC(data)
      const htmlTable = new HtmlTable()
      
      // Add header row using jsvalidator's standard headers
      BandCombinationList.addTableHeaders(htmlTable)
      
      bc.toHTML(htmlTable, 0, 0, ulNoteDescriptions, dlNoteDescriptions)
      
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
            
            // Don't escape HTML tags (like <br>) - render them directly
            const cellContent = value === '&nbsp;' ? '' : value
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
