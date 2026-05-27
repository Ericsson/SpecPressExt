const vscode = require('vscode')

/**
 * Extracts a snippet from the document for comment position tracking.
 * The snippet consists of up to 20 characters BEFORE the cursor position.
 * This allows the comment to remain anchored even after changes are made
 * at or after the cursor position.
 * 
 * @param {vscode.TextDocument} document - The document to extract from
 * @param {vscode.Position} position - The cursor position (comment anchor)
 * @returns {string} The extracted snippet (up to 20 chars before cursor)
 */
function extractSnippet(document, position) {
  // Build snippet by going backwards from the cursor position
  let snippet = ''
  let currentLine = position.line
  let currentCol = position.character
  let charsCollected = 0
  const maxChars = 20
  
  while (charsCollected < maxChars && (currentLine > 0 || currentCol > 0)) {
    if (currentCol > 0) {
      // Take characters from current line
      const lineText = document.lineAt(currentLine).text
      const charsToTake = Math.min(currentCol, maxChars - charsCollected)
      const startCol = currentCol - charsToTake
      const extracted = lineText.substring(startCol, currentCol)
      snippet = extracted + snippet
      charsCollected += charsToTake
      currentCol = startCol
    } else if (currentLine > 0) {
      // Move to previous line and include line ending
      currentLine--
      const prevLineText = document.lineAt(currentLine).text
      currentCol = prevLineText.length
      
      // Add line ending if we have room
      if (charsCollected < maxChars) {
        snippet = '\n' + snippet
        charsCollected++
      }
    }
  }
  
  return snippet
}

module.exports = { extractSnippet }
