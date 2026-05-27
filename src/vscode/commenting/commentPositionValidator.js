const vscode = require('vscode')
const { extractSnippet } = require('./snippetExtractor')

/**
 * Validates if a comment is still at its original position.
 * Returns validation result with status and suggested position if moved.
 * Reply comments are always valid (they follow their parent).
 */
function validateCommentPosition(comment, document) {
  // Reply comments are associated with their parent, not with a text position
  if (comment.replyTo) {
    return { valid: true, status: 'reply' }
  }

  const lineNumber = comment.lineNumber
  const columnNumber = comment.columnNumber || 0
  const snippet = comment.lineSnippet

  if (!snippet) {
    return { valid: true, status: 'no-snippet' }
  }

  // Check if line number is still valid
  if (lineNumber >= document.lineCount) {
    return { valid: false, status: 'line-out-of-range', suggestedPosition: null }
  }

  // Get text at original position using centralized snippet extraction
  const position = new vscode.Position(lineNumber, columnNumber)
  const currentSnippet = extractSnippet(document, position)

  // Exact match - comment is still at correct position
  if (currentSnippet === snippet) {
    return { valid: true, status: 'exact-match' }
  }

  // Try to find the snippet nearby (±10 lines, any column)
  const searchResult = findSnippetNearby(snippet, document, lineNumber, columnNumber)
  
  if (searchResult) {
    return {
      valid: false,
      status: 'moved',
      suggestedPosition: searchResult,
      distance: Math.abs(searchResult.line - lineNumber) + Math.abs(searchResult.character - columnNumber)
    }
  }

  return { valid: false, status: 'not-found', suggestedPosition: null }
}

/**
 * Searches for a snippet in nearby lines (±50 lines from original position).
 * Returns the position if found, null otherwise.
 */
function findSnippetNearby(snippet, document, originalLine, originalColumn, searchRadius = 50) {
  const startLine = Math.max(0, originalLine - searchRadius)
  const endLine = Math.min(document.lineCount - 1, originalLine + searchRadius)

  // Normalize snippet for comparison (collapse whitespace)
  const normalizedSnippet = normalizeSnippet(snippet)
  
  // Search line by line
  for (let line = startLine; line <= endLine; line++) {
    const lineText = document.lineAt(line).text
    
    // Try to find snippet at various column positions
    for (let col = 0; col <= lineText.length; col++) {
      const position = new vscode.Position(line, col)
      const candidateSnippet = extractSnippet(document, position)
      
      // Exact match
      if (candidateSnippet === snippet) {
        return new vscode.Position(line, col)
      }
      
      // Fuzzy match (normalized)
      if (normalizeSnippet(candidateSnippet) === normalizedSnippet) {
        return new vscode.Position(line, col)
      }
    }
  }

  return null
}

/**
 * Normalizes a snippet for fuzzy matching by collapsing whitespace.
 */
function normalizeSnippet(snippet) {
  return snippet.replace(/\s+/g, ' ').trim()
}

/**
 * Validates all comments for a file and returns those that appear to have moved.
 */
async function validateAllCommentsForFile(comments, document) {
  const results = []
  
  for (const comment of comments) {
    // Only validate parent comments (not replies)
    if (comment.replyTo) continue
    
    const validation = validateCommentPosition(comment, document)
    
    if (!validation.valid && validation.status !== 'no-snippet') {
      results.push({
        comment,
        validation
      })
    }
  }
  
  return results
}

module.exports = {
  validateCommentPosition,
  findSnippetNearby,
  validateAllCommentsForFile
}
