const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { concatenateFiles } = require('specpress/lib/common/specProcessor')
const { formatExportTimestamp, showExportNotification } = require('./helpers')
const { selectCoverPage } = require('./coverPageSelector')

/**
 * Handles the HTML export command.
 *
 * @param {import('./stateManager').StateManager} state
 * @param {import('./configLoader').ConfigLoader} config
 * @param {import('./previewManager').PreviewManager} previewMgr
 */
async function exportHtml(state, config, previewMgr) {
  if (!state.panel) {
    vscode.window.showErrorMessage('No preview open')
    return
  }

  const { formatExportMessage } = require('specpress/lib/common/specProcessor')
  const defaultName = `${formatExportTimestamp()} Export.html`
  const saveUri = await vscode.window.showSaveDialog({
    filters: { 'HTML': ['html'] },
    defaultUri: vscode.Uri.file(path.join(config.getExportFolder(state.lastExportFolder), defaultName))
  })

  if (!saveUri) return
  state.lastExportFolder = path.dirname(saveUri.fsPath)

  const htmlPath = saveUri.fsPath
  const exportFolder = path.dirname(htmlPath)
  const mediaFolder = path.join(exportFolder, 'media')

  if (!fs.existsSync(mediaFolder)) {
    fs.mkdirSync(mediaFolder, { recursive: true })
  }

  let htmlContent
  let baseDir
  let specRoot = ''

  if (state.isMultiFilePreview && state.multiFileContent) {
    previewMgr.ensureHandler()
    specRoot = state.multiFilePaths && state.multiFilePaths.length > 0 ? config.getSpecRootForFile(state.multiFilePaths[0]) : ''
    const fpData = state.isSpecRootPreview ? config.loadFrontPageData() : null
    htmlContent = state.handler.renderMarkdownForExport(state.multiFileContent, specRoot, fpData)
    baseDir = state.multiFileBaseDir
  } else if (state.currentEditor) {
    previewMgr.ensureHandler()
    specRoot = config.getSpecRootForFile(state.currentEditor.document.uri.fsPath)
    const text = state.currentEditor.document.fileName.endsWith('.asn')
      ? concatenateFiles([state.currentEditor.document.fileName], () => state.currentEditor.document.getText(), specRoot)
      : state.currentEditor.document.getText()
    htmlContent = state.handler.renderMarkdownForExport(text, specRoot)
    baseDir = path.dirname(state.currentEditor.document.uri.fsPath)
  } else {
    vscode.window.showErrorMessage('Unable to export: no content available')
    return
  }

  // Select cover page (CR, standard front page, or none)
  const coverPageChoice = await selectCoverPage(config, specRoot)
  if (!coverPageChoice) return // User cancelled

  // Prepend cover page HTML if selected
  if (coverPageChoice.type === 'cr' && coverPageChoice.crData) {
    const { renderCRCoverPageHTML } = require('specpress/lib/md2html/crCoverPageRenderer')
    const coverPageHtml = renderCRCoverPageHTML(coverPageChoice.crData)
    htmlContent = coverPageHtml + '\n' + htmlContent
  } else if (coverPageChoice.type === 'standard') {
    const { buildFrontPageHtml } = require('specpress/lib/md2html/frontPage')
    const frontPageData = config.loadFrontPageData()
    if (frontPageData) {
      const frontPageHtml = buildFrontPageHtml(frontPageData)
      htmlContent = frontPageHtml + '\n' + htmlContent
    }
  }

  // Remove data-source attributes
  htmlContent = htmlContent.replace(/\s*data-source-line="\d+"/g, '')
  htmlContent = htmlContent.replace(/\s*data-source-file="[^"]*"/g, '')

  const copiedImages = new Map()
  const workspaceRoot = config.wsRoot

  // Find all image sources and resolve relative to source files
  htmlContent = htmlContent.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/g, (match, before, src, after) => {
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
      return match
    }

    let imagePath
    if (state.isMultiFilePreview && state.multiFilePaths) {
      imagePath = null
      for (const mdFile of state.multiFilePaths) {
        const mdDir = path.dirname(mdFile)
        const testPath = path.isAbsolute(src) ? src : path.join(mdDir, src)
        if (fs.existsSync(testPath)) {
          imagePath = testPath
          break
        }
      }
      if (!imagePath) {
        vscode.window.showWarningMessage(`Image not found: ${src}`)
        return match
      }
    } else {
      imagePath = path.isAbsolute(src) ? src : path.join(baseDir, src)
      if (!fs.existsSync(imagePath)) {
        vscode.window.showWarningMessage(`Image not found: ${imagePath}`)
        return match
      }
    }

    if (copiedImages.has(imagePath)) {
      return `<img${before}src="media/${copiedImages.get(imagePath)}"${after}>`
    }

    let relativePath = workspaceRoot ? path.relative(workspaceRoot, imagePath) : path.basename(imagePath)
    const ext = path.extname(relativePath)
    const nameWithoutExt = relativePath.slice(0, -ext.length)
    const safeName = nameWithoutExt.replace(/[\\/\.]+/g, '_').replace(/^_+/, '') + ext

    const destPath = path.join(mediaFolder, safeName)
    try {
      fs.copyFileSync(imagePath, destPath)
      copiedImages.set(imagePath, safeName)
      return `<img${before}src="media/${safeName}"${after}>`
    } catch (e) {
      vscode.window.showWarningMessage(`Failed to copy image: ${imagePath} - ${e.message}`)
      return match
    }
  })

  fs.writeFileSync(htmlPath, htmlContent)

  const sourceFileCount = state.isMultiFilePreview && state.multiFileAllFiles ? state.multiFileAllFiles.length : 1
  showExportNotification(formatExportMessage('HTML', sourceFileCount, copiedImages.size), exportFolder)
}

module.exports = { exportHtml }
