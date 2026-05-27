const vscode = require('vscode')

/**
 * Detects and loads CR cover page data for a spec root.
 * Shows an error message with an "Open CR File" action if validation fails.
 *
 * @param {string} specRoot - Path to specification root folder.
 * @returns {object|null} CR cover page data, or null if not found/invalid.
 */
function loadCRCoverPage(specRoot) {
  if (!specRoot) return null

  const { detectCRCoverPage } = require('specpress/lib/common/crCoverPageDetector')
  const { loadCRCoverPageData } = require('specpress/lib/common/crCoverPageLoader')

  const crFilePath = detectCRCoverPage(specRoot)
  if (!crFilePath) return null

  const crResult = loadCRCoverPageData(crFilePath)
  if (crResult.valid) return crResult.data

  const errorMsg = `CR cover page validation failed:\n\n${crResult.errors.join('\n')}`
  vscode.window.showErrorMessage(errorMsg, 'Open CR File').then(action => {
    if (action === 'Open CR File') {
      vscode.window.showTextDocument(vscode.Uri.file(crFilePath))
    }
  })
  return null
}

module.exports = { loadCRCoverPage }
