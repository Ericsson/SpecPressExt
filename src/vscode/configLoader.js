const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

/**
 * Centralized configuration service for the SpecPress extension.
 *
 * Caches resolved settings and provides helper methods for path resolution.
 * Call invalidate() when settings change to force re-read on next access.
 */
class ConfigLoader {
  constructor() {
    /** @type {string|null} */
    this._css = null
    /** @type {string|null} */
    this._mermaidConfig = null
    /** @type {string|null} */
    this._coverPageHtml = null
    /** @type {string[]|null} */
    this._specRoots = null
  }

  /** Clears all cached values so they are re-read on next access. */
  invalidate() {
    this._css = null
    this._mermaidConfig = null
    this._coverPageHtml = null
    this._specRoots = null
  }

  /** @returns {string} Workspace root path, or ''. */
  get wsRoot() {
    return vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : ''
  }

  /** @returns {vscode.WorkspaceConfiguration} */
  get raw() {
    return vscode.workspace.getConfiguration('specpress')
  }

  /** @returns {Object} Custom renderers map. */
  get customRenderers() {
    return this.raw.get('renderers', {})
  }

  /** @returns {boolean} Whether section number derivation is enabled. */
  get deriveSectionNumbers() {
    return this.raw.get('deriveSectionNumbers', false)
  }

  /** @returns {string} Cover page template path (raw config value). */
  get coverPageTemplate() {
    return this.raw.get('coverPageTemplate', '')
  }

  /** @returns {string} Cover page data path (raw config value). */
  get coverPageData() {
    return this.raw.get('coverPageData', '')
  }

  /** @returns {string} Multi-page preview default path (raw config value). */
  get multiPagePreviewDefaultPath() {
    return this.raw.get('multiPagePreviewDefaultPath', '')
  }

  /**
   * Loads CSS content from workspace configuration or extension defaults.
   * @param {string} extensionDir - Absolute path to the extension root directory.
   * @returns {string} CSS content.
   */
  loadCss(extensionDir) {
    if (this._css !== null) return this._css
    const cssFile = this.raw.get('cssFile', '')

    if (cssFile && this.wsRoot) {
      const cssPath = path.join(this.wsRoot, cssFile)
      if (fs.existsSync(cssPath)) {
        this._css = fs.readFileSync(cssPath, 'utf8')
        return this._css
      }
    }

    const defaultCssPath = path.join(extensionDir, 'node_modules/specpress/lib/css/3gpp.css')
    if (fs.existsSync(defaultCssPath)) {
      this._css = fs.readFileSync(defaultCssPath, 'utf8')
      return this._css
    }

    this._css = `body{font-family:Arial,sans-serif;padding:20px;max-width:900px;margin:0 auto}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}
code{background:#f4f4f4;padding:2px 6px;border-radius:3px}
pre{background:#f4f4f4;padding:10px;overflow-x:auto}pre code{background:none;padding:0}`
    return this._css
  }

  /**
   * Loads mermaid configuration from workspace settings or extension defaults.
   * @param {string} extensionDir - Absolute path to the extension root directory.
   * @returns {string} Mermaid config JSON string.
   */
  loadMermaidConfig(extensionDir) {
    if (this._mermaidConfig !== null) return this._mermaidConfig
    const mermaidConfigFile = this.raw.get('mermaidConfigFile', '')

    if (mermaidConfigFile && this.wsRoot) {
      const mermaidPath = path.join(this.wsRoot, mermaidConfigFile)
      if (fs.existsSync(mermaidPath)) {
        this._mermaidConfig = fs.readFileSync(mermaidPath, 'utf8')
        return this._mermaidConfig
      }
    }

    const defaultMermaidPath = path.join(extensionDir, 'node_modules/specpress/lib/css/mermaid-config.json')
    if (fs.existsSync(defaultMermaidPath)) {
      this._mermaidConfig = fs.readFileSync(defaultMermaidPath, 'utf8')
      return this._mermaidConfig
    }

    this._mermaidConfig = '{}'
    return this._mermaidConfig
  }

  /**
   * Loads and renders the cover page HTML from configured template and data files.
   * @returns {string} Rendered cover page HTML, or empty string.
   */
  loadCoverPage() {
    if (this._coverPageHtml !== null) return this._coverPageHtml
    const templateFile = this.coverPageTemplate
    const dataFile = this.coverPageData
    if (!templateFile || !dataFile || !this.wsRoot) {
      this._coverPageHtml = ''
      return this._coverPageHtml
    }

    const templatePath = path.isAbsolute(templateFile) ? templateFile : path.join(this.wsRoot, templateFile)
    const dataPath = path.isAbsolute(dataFile) ? dataFile : path.join(this.wsRoot, dataFile)

    if (!fs.existsSync(templatePath)) {
      vscode.window.showWarningMessage(`SpecPress: Cover page template not found: ${templateFile}`)
      this._coverPageHtml = ''
      return this._coverPageHtml
    }
    if (!fs.existsSync(dataPath)) {
      vscode.window.showWarningMessage(`SpecPress: Cover page data file not found: ${dataFile}`)
      this._coverPageHtml = ''
      return this._coverPageHtml
    }

    try {
      let template = fs.readFileSync(templatePath, 'utf8')
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'))

      const bodyMatch = template.match(/<body[^>]*>([\s\S]*)<\/body>/i)
      if (bodyMatch) {
        const styles = []
        const styleRe = /<style[^>]*>[\s\S]*?<\/style>/gi
        let m
        while ((m = styleRe.exec(template)) !== null) styles.push(m[0])
        template = (styles.length ? styles.join('\n') + '\n' : '') + bodyMatch[1]
      }

      if (!data.YEAR && data.DATE) {
        data.YEAR = data.DATE.split('-')[0] || ''
      }

      let result = template.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] !== undefined ? data[key] : match)

      const templateDir = path.dirname(templatePath)
      result = result.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/g, (match, before, src, after) => {
        if (src.startsWith('http') || src.startsWith('data:') || path.isAbsolute(src)) return match
        const absPath = path.join(templateDir, src)
        if (fs.existsSync(absPath)) return `<img${before}src="${absPath.replace(/\\/g, '/')}"${after}>`
        return match
      })

      this._coverPageHtml = result
    } catch (e) {
      vscode.window.showWarningMessage(`SpecPress: Failed to load cover page: ${e.message}`)
      this._coverPageHtml = ''
    }
    return this._coverPageHtml
  }

  /**
   * Resolves specificationRootPath config to an array of absolute paths.
   * @returns {string[]} Array of absolute spec root paths (may be empty).
   */
  resolveSpecRoots() {
    if (this._specRoots !== null) return this._specRoots
    const raw = this.raw.get('specificationRootPath', '')
    const entries = Array.isArray(raw) ? raw : (raw ? [raw] : [])
    const wsRoot = this.wsRoot
    this._specRoots = entries
      .filter(e => typeof e === 'string' && e.trim())
      .map(e => path.isAbsolute(e) ? e : wsRoot ? path.join(wsRoot, e) : e)
      .filter(e => {
        if (!wsRoot) return true
        const rel = path.relative(wsRoot, e)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          vscode.window.showWarningMessage(`SpecPress: specificationRootPath "${e}" is outside the workspace and will be ignored.`)
          return false
        }
        return true
      })
    return this._specRoots
  }

  /**
   * Checks whether a file path is inside any configured specification root.
   * @param {string} filePath - Absolute path to check.
   * @returns {boolean}
   */
  isInsideSpecRoot(filePath) {
    return this.resolveSpecRoots().some(root => {
      const rel = path.relative(root, filePath)
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    })
  }

  /**
   * Finds the spec root that contains the given file.
   * @param {string} filePath - Absolute path to a file.
   * @returns {string} The matching spec root, or '' if none.
   */
  findSpecRootFor(filePath) {
    for (const root of this.resolveSpecRoots()) {
      const rel = path.relative(root, filePath)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return root
    }
    return ''
  }

  /**
   * Returns the spec root for section number derivation for a given file.
   * @param {string} [filePath=''] - Absolute path to resolve the root for.
   * @returns {string} Matching spec root, or '' if disabled or no match.
   */
  getSpecRootForFile(filePath) {
    if (!this.deriveSectionNumbers) return ''
    return filePath ? this.findSpecRootFor(filePath) : ''
  }

  /**
   * Checks whether any of the given URIs is a spec root directory.
   * @param {import('vscode').Uri[]} uris - Array of file or folder URIs.
   * @returns {boolean}
   */
  isSpecRootSelection(uris) {
    const roots = this.resolveSpecRoots()
    return uris.some(u => roots.some(root => path.resolve(u.fsPath) === path.resolve(root)))
  }

  /**
   * Resolves the default folder for export dialogs.
   * @param {string|null} lastExportFolder - Last folder chosen in this session.
   * @returns {string} Absolute path to the default export folder.
   */
  getExportFolder(lastExportFolder) {
    if (lastExportFolder && fs.existsSync(lastExportFolder)) return lastExportFolder
    const configured = this.raw.get('defaultExportFolder', '')
    if (configured) {
      const abs = path.isAbsolute(configured) ? configured : (this.wsRoot ? path.join(this.wsRoot, configured) : configured)
      if (fs.existsSync(abs)) return abs
    }
    return this.wsRoot || ''
  }
}

module.exports = { ConfigLoader }
