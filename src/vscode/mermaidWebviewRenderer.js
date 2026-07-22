const vscode = require('vscode')
const path = require('path')
const { buildMermaidPageScript } = require('specpress')

/**
 * Renders mermaid diagrams via a hidden VS Code webview panel.
 *
 * Uses buildMermaidPageScript from specpress to share the render logic with
 * the headless browser path, differing only in the result transport
 * (postMessage instead of fetch POST).
 *
 * @param {string[]} codes - Mermaid source strings.
 * @param {string} mermaidConfig - Mermaid init config JSON string.
 * @param {string} mermaidBundlePath - Absolute path to the cached mermaid.min.js.
 * @returns {Promise<{svg: string|null, png: Buffer|null}[]>}
 */
function renderMermaidViaWebview(codes, mermaidConfig, mermaidBundlePath) {
  if (!codes || codes.length === 0) return Promise.resolve([])
  const config = mermaidConfig || '{}'

  return new Promise((resolve) => {
    const previousEditor = vscode.window.activeTextEditor
    const localRoot = vscode.Uri.file(path.dirname(mermaidBundlePath))
    const panel = vscode.window.createWebviewPanel(
      'specpressMermaid', 'Mermaid Render',
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [localRoot] }
    )
    if (previousEditor) {
      vscode.window.showTextDocument(previousEditor.document, previousEditor.viewColumn, false)
    }

    const pageScript = buildMermaidPageScript(codes, config)
    const mermaidUri = panel.webview.asWebviewUri(vscode.Uri.file(mermaidBundlePath))

    panel.webview.html = `<!DOCTYPE html>
<html><head>
<script src="${mermaidUri}"></script>
</head><body>
<script>
const vscodeApi = acquireVsCodeApi();
(async () => {
${pageScript}
vscodeApi.postMessage({ type: 'mermaidResults', results });
})();
</script>
</body></html>`

    const timeout = setTimeout(() => {
      panel.dispose()
      resolve(codes.map(() => ({ svg: null, png: null })))
    }, 30000)

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'mermaidResults') {
        clearTimeout(timeout)
        panel.dispose()
        resolve(msg.results.map(r => r && typeof r === 'object'
          ? { svg: r.svg, png: r.png ? Buffer.from(r.png, 'base64') : null }
          : { svg: null, png: null }
        ))
      }
    })

    panel.onDidDispose(() => clearTimeout(timeout))
  })
}

module.exports = { renderMermaidViaWebview }
