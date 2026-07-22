const vscode = require('vscode')
const { extractSectionNumber } = require('specpress')

/**
 * Provides explorer tooltip decorations showing the derived section number
 * and heading for files and folders inside the specificationRootPath.
 * Only active when specpress.deriveSectionNumbers is true.
 */
class SectionDecorationProvider {
  constructor(config) {
    this._config = config
    this._emitter = new vscode.EventEmitter()
    this.onDidChangeFileDecorations = this._emitter.event
  }

  provideFileDecoration(uri) {
    if (!this._config.raw.get('deriveSectionNumbers', false)) return undefined
    const specRoots = this._config.resolveSpecRoots()
    if (!specRoots.length) return undefined

    const fsPath = uri.fsPath
    const root = specRoots.find(r => fsPath.toLowerCase().startsWith(r.toLowerCase()))
    if (!root) return undefined

    const { sectionNumber, sectionHeading } = extractSectionNumber(fsPath, root)
    if (!sectionNumber) return undefined

    const text = sectionHeading ? `${sectionNumber} ${sectionHeading}` : sectionNumber
    return {
      tooltip: text
    }
  }

  /** Call when configuration changes to refresh all decorations. */
  refresh() {
    this._emitter.fire(undefined)
  }

  dispose() {
    this._emitter.dispose()
  }
}

module.exports = { SectionDecorationProvider }
