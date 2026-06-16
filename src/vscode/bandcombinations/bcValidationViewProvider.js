const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const os = require('os')

class BcValidationViewProvider {
  constructor(config) {
    this.config = config
    this._view = null
  }

  resolveWebviewView(webviewView, context, token) {
    this._view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    }

    webviewView.webview.html = this.getHtmlContent()

    webviewView.webview.onDidReceiveMessage(async message => {
      if (message.command === 'validate') {
        await this.runValidation(message.scope, message.skipContent, message.skipSchema)
      } else if (message.command === 'openLog') {
        await this.openLogFile(message.logPath)
      } else if (message.command === 'refresh') {
        this.updateLogList()
      } else if (message.command === 'ready') {
        // Webview is ready, send initial log list
        this.updateLogList()
      }
    })
  }

  async runValidation(scope, skipContentValidation, skipSchemaValidation) {
    const bcFolder = this.config.raw.get('bandCombinationFolder', '')
    if (!bcFolder) {
      vscode.window.showWarningMessage('bandCombinationFolder is not configured')
      return
    }

    const absFolder = path.isAbsolute(bcFolder)
      ? bcFolder
      : this.config.wsRoot ? path.join(this.config.wsRoot, bcFolder) : bcFolder

    if (!fs.existsSync(absFolder)) {
      vscode.window.showErrorMessage(`bandCombinationFolder does not exist: ${absFolder}`)
      return
    }

    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    const seconds = String(now.getSeconds()).padStart(2, '0')
    const timestamp = `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`
    const logPath = path.join(os.tmpdir(), `specpress-bc-validation-${timestamp}.log`)

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Validating Band Combinations',
        cancellable: false
      },
      async (progress) => {
        try {
          progress.report({ message: 'Loading jsvalidator...' })
          const { loadAndValidateAll } = await import('ran4-jsvalidator/src/ValidateData.js')
          const { logger } = await import('ran4-jsvalidator/src/Logger.js')

          progress.report({ message: 'Opening log file...' })
          await logger.openFile(logPath)

          progress.report({ message: 'Loading and validating files...' })

          let result
          if (scope === 'bands') {
            const { RAN4DataHandler } = await import('ran4-jsvalidator/src/RAN4DataHandler.js')
            const { LoadSchema } = await import('ran4-jsvalidator/src/JsonTools.js')
            const db = new RAN4DataHandler()

            let schemaBand = null
            if (!skipSchemaValidation) {
              schemaBand = LoadSchema(path.join(absFolder, 'common/jsonSchemas/Band.json'))
            }

            const r1 = db.chBwList.loadByPattern(absFolder, 'n*.json', skipContentValidation, schemaBand, false)
            const exitCode = (r1.contentErrors > 0 ? 1 : 0) | (r1.schemaErrors > 0 ? 2 : 0)
            result = { exitCode }
          } else if (scope === 'bands+ca') {
            const { RAN4DataHandler } = await import('ran4-jsvalidator/src/RAN4DataHandler.js')
            const { LoadSchema } = await import('ran4-jsvalidator/src/JsonTools.js')
            const db = new RAN4DataHandler()

            let schemaBand = null
            let schemaCA = null
            if (!skipSchemaValidation) {
              schemaBand = LoadSchema(path.join(absFolder, 'common/jsonSchemas/Band.json'))
              schemaCA = LoadSchema(path.join(absFolder, 'common/jsonSchemas/BandCombinationsCarrierAggregation.json'))
            }

            const r1 = db.chBwList.loadByPattern(absFolder, 'n*.json', skipContentValidation, schemaBand, false)
            const r2 = db.bcList.loadByPattern(absFolder, 'CA_*.json', skipContentValidation, schemaCA, false)
            const exitCode = ((r1.contentErrors + r2.contentErrors) > 0 ? 1 : 0) | ((r1.schemaErrors + r2.schemaErrors) > 0 ? 2 : 0)
            result = { exitCode }
          } else {
            result = loadAndValidateAll(absFolder, skipContentValidation, skipSchemaValidation, false)
          }

          const schemaStatus = skipSchemaValidation ? 'skipped' : 'done'
          const contentStatus = skipContentValidation ? 'skipped' : 'done'
          logger.log(`Validation complete. Schema: ${schemaStatus}, Content: ${contentStatus}, Exit code: ${result.exitCode}`)

          await logger.close()

          progress.report({ message: 'Complete' })

          if (result.exitCode === 0) {
            const action = await vscode.window.showInformationMessage(
              'Validation completed successfully - no errors found',
              'Open Log'
            )
            if (action === 'Open Log') {
              await this.openLogFile(logPath)
            }
          } else {
            const errors = []
            if (result.exitCode & 1) errors.push('content errors')
            if (result.exitCode & 2) errors.push('schema errors')

            const action = await vscode.window.showErrorMessage(
              `Validation failed with ${errors.join(' and ')}`,
              'Open Log'
            )
            if (action === 'Open Log') {
              await this.openLogFile(logPath)
            }
          }

          this.updateLogList()
        } catch (e) {
          vscode.window.showErrorMessage(`Validation failed: ${e.message}`)
        }
      }
    )
  }

  async openLogFile(logPath) {
    try {
      const doc = await vscode.workspace.openTextDocument(logPath)
      await vscode.window.showTextDocument(doc)
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to open log: ${e.message}`)
    }
  }

  updateLogList() {
    if (!this._view || !this._view.webview) return

    const logs = this.getRecentLogFiles()
    
    // Small delay to ensure webview is ready
    setTimeout(() => {
      try {
        if (this._view && this._view.webview) {
          this._view.webview.postMessage({ command: 'updateLogs', logs })
        }
      } catch (e) {
        // Webview might not be ready yet, ignore
      }
    }, 100)
  }

  getRecentLogFiles() {
    const tmpDir = os.tmpdir()
    const logs = []

    try {
      const files = fs.readdirSync(tmpDir)
      const logFiles = files
        .filter(f => f.startsWith('specpress-bc-validation-') && f.endsWith('.log'))
        .map(f => {
          const fullPath = path.join(tmpDir, f)
          try {
            const stats = fs.statSync(fullPath)
            return { path: fullPath, mtime: stats.mtime, name: f }
          } catch (e) {
            return null
          }
        })
        .filter(f => f !== null)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5)

      for (const log of logFiles) {
        // Match pattern: specpress-bc-validation-2024-01-15-14-30-00.log
        const match = log.name.match(/specpress-bc-validation-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.log/)
        if (match) {
          const timestamp = match[1]
          // Split into date and time parts: 2024-01-15-14-30-00 -> 2024-01-15 14:30:00
          const parts = timestamp.split('-')
          if (parts.length === 6) {
            const date = `${parts[0]}-${parts[1]}-${parts[2]}`
            const time = `${parts[3]}:${parts[4]}:${parts[5]}`
            logs.push({ path: log.path, label: `${date} ${time}` })
          }
        }
      }
    } catch (e) {
      // Silently handle errors
    }

    return logs
  }

  getHtmlContent() {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      padding: 10px 10px 5px 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      margin: 0;
    }
    
    button {
      width: 100%;
      padding: 8px;
      margin: 5px 0;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      cursor: pointer;
      font-size: 13px;
      text-align: left;
    }
    
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    
    .section {
      margin: 10px 0;
    }
    
    .section:first-child {
      margin-top: 0;
    }
    
    .section-title {
      font-weight: bold;
      margin-bottom: 8px;
      font-size: 11px;
      text-transform: uppercase;
      opacity: 0.8;
    }
    
    select {
      width: 100%;
      padding: 4px;
      margin: 3px 0;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
    }
    
    label {
      display: flex;
      align-items: center;
      margin: 5px 0;
      cursor: pointer;
      font-size: 12px;
    }
    
    input[type="checkbox"] {
      margin-right: 6px;
    }
    
    .log-list {
      margin-top: 10px;
    }
    
    .log-item {
      padding: 6px 8px;
      margin: 3px 0;
      background: var(--vscode-list-hoverBackground);
      cursor: pointer;
      font-size: 11px;
      border-radius: 2px;
    }
    
    .log-item:hover {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    
    .no-logs {
      padding: 8px;
      font-size: 11px;
      opacity: 0.6;
      font-style: italic;
    }
    
    .refresh-btn {
      font-size: 11px;
      padding: 4px 8px;
      width: auto;
      float: right;
    }
  </style>
</head>
<body>
  <div class="section">
    <div class="section-title">Validation Scope</div>
    <select id="scope">
      <option value="bands">Bands only</option>
      <option value="bands+ca">Bands + CA</option>
      <option value="bands+ca+dc" selected>Bands + CA + DC</option>
    </select>
  </div>
  
  <div class="section">
    <div class="section-title">Validation Types</div>
    <label>
      <input type="checkbox" id="contentValidation" checked>
      Content validation
    </label>
    <label>
      <input type="checkbox" id="schemaValidation" checked>
      Schema validation
    </label>
  </div>
  
  <div class="section">
    <button id="validateBtn">▶ Run Validation</button>
  </div>
  
  <div class="section">
    <div class="section-title">
      Recent Logs
      <button class="refresh-btn" id="refreshBtn">⟳</button>
    </div>
    <div class="log-list" id="logList">
      <div class="no-logs">No logs available</div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    // Notify extension that webview is ready
    window.addEventListener('load', () => {
      vscode.postMessage({ command: 'ready' });
    });
    
    document.getElementById('validateBtn').addEventListener('click', () => {
      const scope = document.getElementById('scope').value;
      const skipContent = !document.getElementById('contentValidation').checked;
      const skipSchema = !document.getElementById('schemaValidation').checked;
      
      vscode.postMessage({
        command: 'validate',
        scope: scope,
        skipContent: skipContent,
        skipSchema: skipSchema
      });
    });
    
    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });
    
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'updateLogs') {
        const logList = document.getElementById('logList');
        
        if (message.logs.length === 0) {
          logList.innerHTML = '<div class="no-logs">No logs available</div>';
        } else {
          logList.innerHTML = message.logs.map(log => 
            \`<div class="log-item" data-path="\${log.path}">\${log.label}</div>\`
          ).join('');
          
          document.querySelectorAll('.log-item').forEach(item => {
            item.addEventListener('click', () => {
              vscode.postMessage({
                command: 'openLog',
                logPath: item.getAttribute('data-path')
              });
            });
          });
        }
      }
    });
  </script>
</body>
</html>`
  }
}

module.exports = { BcValidationViewProvider }
