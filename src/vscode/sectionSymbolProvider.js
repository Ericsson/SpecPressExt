const vscode = require('vscode')
const { extractSectionNumber, parsePlaceholder } = require('specpress')

const HEADING_RE = /^(#{1,6})\s+(.*)/

/**
 * Provides document symbols for markdown files inside the spec root,
 * replacing x-placeholders with derived section numbers so the Outline
 * view shows resolved headings (e.g. "3.2 Abbreviations" instead of
 * "x.x Abbreviations").
 *
 * Falls back to undefined (letting VS Code use its default provider)
 * for files outside the spec root or when deriveSectionNumbers is false.
 */
class SectionSymbolProvider {
  constructor(config) {
    this._config = config
  }

  provideDocumentSymbols(document) {
    if (!this._config.raw.get('deriveSectionNumbers', false)) return undefined
    const specRoots = this._config.resolveSpecRoots()
    if (!specRoots.length) return undefined

    const fsPath = document.uri.fsPath
    const root = specRoots.find(r => fsPath.toLowerCase().startsWith(r.toLowerCase()))
    if (!root) return undefined

    const { sectionNumber } = extractSectionNumber(fsPath, root)
    const derivedDepth = sectionNumber ? sectionNumber.split('.').length : 0

    const symbols = []
    const stack = [] // stack of { symbol, level }
    const lines = document.getText().split('\n')

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(HEADING_RE)
      if (!m) continue

      const level = m[1].length
      const rawText = m[2].trim()
      const parsed = sectionNumber ? parsePlaceholder(rawText) : null

      let label
      if (parsed) {
        const resolved = parsed.actualSectionNumber.replace(parsed.placeholder, sectionNumber)
        label = rawText.replace(parsed.actualSectionNumber, resolved)
      } else {
        label = rawText
      }

      const range = new vscode.Range(i, 0, i, lines[i].length)
      const symbol = new vscode.DocumentSymbol(
        label,
        '',
        vscode.SymbolKind.String,
        range,
        range
      )

      // Pop stack to find the right parent
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()

      if (stack.length) {
        stack[stack.length - 1].symbol.children.push(symbol)
      } else {
        symbols.push(symbol)
      }

      stack.push({ symbol, level })
    }

    return symbols
  }
}

module.exports = { SectionSymbolProvider }
