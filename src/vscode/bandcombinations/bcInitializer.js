const vscode = require('vscode')
const { BcTreeProvider } = require('./bcTreeProvider')
const { BcFilterViewProvider } = require('./bcFilterViewProvider')
const { BcValidationViewProvider } = require('./bcValidationViewProvider')
const { BcPreviewManager } = require('./bcPreviewManager')
const { bcRefresh, openBcPreview, configureBcFolder, bcNormalize, bcPreviewFiltered, bcExportGitDiff, bcTogglePreview } = require('./bcCommands')

/**
 * Initializes the Band Combination pane with all its views, providers, and commands
 * @param {vscode.ExtensionContext} context - The extension context
 * @param {StateManager} state - The state manager instance
 * @param {ConfigLoader} config - The config loader instance
 */
function initializeBandCombinationPane(context, state, config) {
  // Initialize managers and providers
  const bcPreviewManager = new BcPreviewManager(state, config)
  const bcTreeProvider = new BcTreeProvider(config, bcPreviewManager)
  const bcFilterViewProvider = new BcFilterViewProvider(bcTreeProvider)
  const bcValidationViewProvider = new BcValidationViewProvider(config)

  // Initialize auto preview state (default to enabled)
  state.bcAutoPreviewEnabled = true
  vscode.commands.executeCommand('setContext', 'specpress.bcAutoPreviewEnabled', true)

  // Register BC tree view
  const bcTreeView = vscode.window.createTreeView('specpressBcTree', {
    treeDataProvider: bcTreeProvider,
    showCollapseAll: false
  })
  bcTreeProvider.treeView = bcTreeView
  context.subscriptions.push(bcTreeView)

  // Register BC filter view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'specpressBcFilter',
      bcFilterViewProvider
    )
  )

  // Register BC validation view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'specpressBcValidation',
      bcValidationViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  )

  // Register BC commands
  context.subscriptions.push(
    vscode.commands.registerCommand('specpress.bcRefresh', () => bcRefresh(bcTreeProvider)),
    vscode.commands.registerCommand('specpress.configureBcFolder', () => configureBcFolder()),
    vscode.commands.registerCommand('specpress.bcNormalize', () => bcNormalize()),
    vscode.commands.registerCommand('specpress.bcPreviewFiltered', () => bcPreviewFiltered(bcTreeProvider, bcPreviewManager)),
    vscode.commands.registerCommand('specpress.bcExportGitDiff', () => bcExportGitDiff(config)),
    vscode.commands.registerCommand('specpress.bcTogglePreview', () => bcTogglePreview(state)),
    vscode.commands.registerCommand('specpress.openBcPreview', (uri) => {
      const filePath = uri ? (uri.fsPath || uri) : null
      if (!filePath) {
        vscode.window.showErrorMessage('No file selected for BC preview')
        return
      }
      openBcPreview(bcPreviewManager, filePath, bcTreeView, state)
    })
  )

  context.subscriptions.push(bcPreviewManager)
  context.subscriptions.push(bcTreeProvider)

  // Return references in case they're needed elsewhere
  return {
    bcPreviewManager,
    bcTreeProvider,
    bcFilterViewProvider,
    bcValidationViewProvider,
    bcTreeView
  }
}

module.exports = { initializeBandCombinationPane }
