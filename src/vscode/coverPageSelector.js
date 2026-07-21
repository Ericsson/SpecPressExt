const vscode = require('vscode')
const path = require('path')
const { detectCRCoverPage } = require('specpress/lib/common/crCoverPageDetector')
const { loadCRCoverPageData } = require('specpress/lib/common/crCoverPageLoader')
/**
 * Prompts the user to select a cover page type for export.
 * Detects available options (CR cover page, standard front page) and presents them.
 *
 * @param {import('./configLoader').ConfigLoader} config - Configuration loader
 * @param {string} specRoot - Specification root path (or empty string if none)
 * @returns {Promise<{type: 'cr'|'standard'|'none', crData?: Object, frontPage?: Object}|null>}
 *   Returns null if user cancelled, otherwise an object with type and optional data
 */
async function selectCoverPage(config, specRoot) {
  // Detect what's available
  const crFilePath = specRoot ? detectCRCoverPage(specRoot) : null
  const hasFrontPageData = config.loadFrontPageData() !== null

  // Build options list
  const options = []

  if (crFilePath) {
    // Validate CR cover page data
    const crResult = loadCRCoverPageData(crFilePath)

    if (crResult.valid) {
      options.push({
        label: `$(file) CR Cover Page (${path.basename(crFilePath)})`,
        description: '',
        value: 'cr',
        crData: crResult.data
      })
    } else {
      options.push({
        label: `$(error) CR Cover Page (${path.basename(crFilePath)})`,
        description: 'Invalid - ' + crResult.errors[0],
        value: 'cr-invalid',
        errors: crResult.errors,
        crFilePath
      })
    }
  }

  if (hasFrontPageData) {
    options.push({
      label: '$(book) Standard Front Page',
      description: '',
      value: 'standard'
    })
  }

  options.push({
    label: '$(circle-slash) No Cover Page',
    description: '',
    value: 'none'
  })

  // If only "No Cover Page" is available, return it automatically
  if (options.length === 1) {
    return { type: 'none' }
  }

  // Show quick pick
  const choice = await vscode.window.showQuickPick(options, {
    placeHolder: 'Select cover page type for export'
  })

  if (!choice) return null // User cancelled

  if (choice.value === 'cr-invalid') {
    // Show detailed error and offer to open file
    const errorMsg = `CR cover page validation failed:\n\n${choice.errors.join('\n')}\n\nClick "Open CR File" to fix the errors.`
    const action = await vscode.window.showErrorMessage(errorMsg, 'Open CR File', 'Cancel')

    if (action === 'Open CR File') {
      await vscode.window.showTextDocument(vscode.Uri.file(choice.crFilePath))
    }
    return null
  }

  if (choice.value === 'cr') {
    return { type: 'cr', crData: choice.crData }
  }

  if (choice.value === 'standard') {
    const data = config.loadFrontPageData()
    if (data) return { type: 'standard', frontPage: data }
  }

  return { type: 'none' }
}

module.exports = { selectCoverPage }
