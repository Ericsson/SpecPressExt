const vscode = require('vscode')
const { extractSectionNumber, parsePlaceholder, parseCaptionPlaceholder } = require('specpress')

const HEADING_RE = /^(#{1,6})\s+(.*)/
const CAPTION_RE = /^(Figure|Table)\s+(.*)/i

/**
 * Shows the resolved section heading as a hover when the cursor is on a
 * markdown heading line containing an x-placeholder, or on a Figure/Table
 * caption line containing an x-placeholder.
 * Only active for files inside specificationRootPath with deriveSectionNumbers true.
 */
class SectionHoverProvider {
  constructor(config) {
    this._config = config
  }

  provideHover(document, position) {
    if (!this._config.raw.get('deriveSectionNumbers', false)) return undefined
    const specRoots = this._config.resolveSpecRoots()
    if (!specRoots.length) return undefined

    const fsPath = document.uri.fsPath
    const root = specRoots.find(r => fsPath.toLowerCase().startsWith(r.toLowerCase()))
    if (!root) return undefined

    const { sectionNumber } = extractSectionNumber(fsPath, root)
    if (!sectionNumber) return undefined

    const line = document.lineAt(position.line).text

    // Heading line
    const hm = line.match(HEADING_RE)
    if (hm) {
      const rawText = hm[2].trim()
      const parsed = parsePlaceholder(rawText)
      if (!parsed) return undefined
      const resolved = parsed.actualSectionNumber.replace(parsed.placeholder, sectionNumber)
      const label = rawText.replace(parsed.actualSectionNumber, resolved)
      return new vscode.Hover(
        new vscode.MarkdownString(`**§ ${label}**`),
        new vscode.Range(position.line, 0, position.line, line.length)
      )
    }

    // Figure/Table caption line
    const cm = line.match(CAPTION_RE)
    if (cm) {
      const keyword = cm[1]
      const afterKeyword = cm[2]
      const parsed = parseCaptionPlaceholder(afterKeyword)
      if (!parsed) return undefined

      // Find the most recently resolved heading above this line
      let currentSection = null
      let currentLevel = 0
      for (let i = position.line - 1; i >= 0; i--) {
        const hMatch = document.lineAt(i).text.match(HEADING_RE)
        if (!hMatch) continue
        const hp = parsePlaceholder(hMatch[2].trim())
        if (!hp) continue
        const resolved = hp.actualSectionNumber.replace(hp.placeholder, sectionNumber)
        currentSection = resolved
        currentLevel = resolved.split('.').length
        break
      }

      if (!currentSection || parsed.placeholderLevel !== currentLevel) return undefined
      const resolvedCaption = line.replace(parsed.placeholder, currentSection)
      return new vscode.Hover(
        new vscode.MarkdownString(`**${resolvedCaption}**`),
        new vscode.Range(position.line, 0, position.line, line.length)
      )
    }

    return undefined
  }
}

module.exports = { SectionHoverProvider }
