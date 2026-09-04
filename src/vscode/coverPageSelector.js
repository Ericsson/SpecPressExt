const vscode = require('vscode')
const path = require('path')
const { detectCRCoverPage, loadCRCoverPageData } = require('specpress')
/**
 * Prompts the user to select a cover page type for export.
 * Detects available options (CR cover page, standard front page) and presents them.
 *
 * @param {import('./configLoader').ConfigLoader} config - Configuration loader
 * @param {string} specRoot - Specification root path (or empty string if none)
 * @returns {Promise<{type: 'cr'|'standard'|'none', crData?: Object, frontPage?: Object}|null>}
 *   Returns null if user cancelled or dismissed the CR validation warning,
 *   otherwise an object with type and optional data
 */
async function selectCoverPage(config, specRoot) {
  const crFilePath = specRoot ? detectCRCoverPage(specRoot) : null
  const hasFrontPageData = config.loadFrontPageData() !== null

  const options = []

  if (crFilePath) {
    const tdocPattern = config.getTdocPattern()
    const crResult = loadCRCoverPageData(crFilePath, tdocPattern ? { tdocPattern } : {})
    options.push({
      label: `$(file) CR Cover Page (${path.basename(crFilePath)})`,
      description: '',
      value: 'cr',
      crData: crResult.data,
      errors: crResult.errors,
      crFilePath
    })
  }

  if (hasFrontPageData) {
    options.push({ label: '$(book) Standard Front Page', description: '', value: 'standard' })
  }

  options.push({ label: '$(circle-slash) No Cover Page', description: '', value: 'none' })

  if (options.length === 1) return { type: 'none' }

  const choice = await vscode.window.showQuickPick(options, { placeHolder: 'Select cover page type for export' })
  if (!choice) return null

  if (choice.value === 'cr') {
    if (choice.errors && choice.errors.length > 0) {
      const msg = `CR cover page has validation issues:\n\n${choice.errors.join('\n')}\n\nThe cover page will be included as-is.`
      const action = await vscode.window.showWarningMessage(msg, { modal: true }, 'Continue', 'Open CR meta data')
      if (action === 'Open CR meta data') await vscode.window.showTextDocument(vscode.Uri.file(choice.crFilePath))
      if (!action || action === 'Open CR meta data') return null
    }
    return { type: 'cr', crData: choice.crData, crFilePath: choice.crFilePath }
  }
  if (choice.value === 'standard') {
    const data = config.loadFrontPageData()
    if (data) return { type: 'standard', frontPage: data }
  }
  return { type: 'none' }
}

module.exports = { selectCoverPage }
