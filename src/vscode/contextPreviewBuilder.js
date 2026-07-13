const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const { collectFiles, concatenateFiles } = require('specpress/lib/common/specProcessor')
const { loadCRCoverPage } = require('./crCoverPageHelper')
const { applyDiff } = require('./diffRenderer')

/**
 * Collects files in the spec root and builds context around the current file.
 * @param {Object} config - ConfigLoader instance.
 * @param {string} currentFilePath - Path to the currently open file.
 * @returns {{ files: string[], currentIndex: number }}
 */
function buildFileContext(config, currentFilePath) {
  const specRoot = config.getSpecRootForFile(currentFilePath)
  if (!specRoot) return { files: [currentFilePath], currentIndex: 0 }

  const allFiles = collectFiles([specRoot]).filter(f => f.endsWith('.md') || f.endsWith('.markdown') || f.endsWith('.asn'))
  const currentIndex = allFiles.findIndex(f => path.normalize(f) === path.normalize(currentFilePath))

  if (currentIndex === -1) return { files: [currentFilePath], currentIndex: 0 }
  return { files: allFiles, currentIndex }
}

/**
 * Builds the full preview HTML with current file + adjacent files.
 * @param {Object} state - StateManager instance.
 * @param {Object} config - ConfigLoader instance.
 * @param {Function} ensureHandler - Function to ensure handler is initialized.
 * @returns {string} Complete HTML document.
 */
function buildContextPreview(state, config, ensureHandler) {
  if (!state.currentEditor || state.contextFiles.length === 0) return ''

  const currentFilePath = state.currentEditor.document.uri.fsPath

  // Initialize context window if not set
  if (state.contextStartIdx === -1) {
    state.contextStartIdx = Math.max(0, state.currentFileIndex - 1)
    state.contextEndIdx = Math.min(state.contextFiles.length - 1, state.currentFileIndex + 1)
  }

  // Get files in context window
  const contextFiles = []
  for (let i = state.contextStartIdx; i <= state.contextEndIdx; i++) {
    contextFiles.push(state.contextFiles[i])
  }

  const isAtSpecStart = state.contextStartIdx === 0
  const specRoot = config.getSpecRootForFile(currentFilePath)

  // Detect CR cover page if at spec start
  const crCoverPageData = isAtSpecStart ? loadCRCoverPage(specRoot) : null

  // Use concatenateFiles to get proper auto-headings and section numbering
  const readFile = (filePath) => {
    if (filePath === currentFilePath && state.currentEditor) {
      return state.currentEditor.document.getText()
    }
    return fs.readFileSync(filePath, 'utf8')
  }

  const concatenated = concatenateFiles(contextFiles, readFile, specRoot)

  ensureHandler()

  const baseDir = path.dirname(currentFilePath)
  const frontPageData = isAtSpecStart ? config.loadFrontPageData() : null
  let html = state.handler.renderMarkdown(concatenated, baseDir, null, specRoot, frontPageData, crCoverPageData)

  html = applyDiff(state, state.handler, config, html, concatenated, null, contextFiles, {
    baseDir,
    specRoot,
    frontPageData,
    crCoverPageData
  })

  return html
}

module.exports = { buildFileContext, buildContextPreview }
