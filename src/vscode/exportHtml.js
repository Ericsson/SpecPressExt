const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const { getRepoRoot } = require('specpress/lib/common/gitHelpers')
const { createCommitResolver, createLocalResolver } = require('specpress/lib/common/fileResolver')
const { collectFiles, concatenateFiles, formatExportMessage } = require('specpress/lib/common/specProcessor')
const { Md2Html } = require('specpress/lib/md2html/md2html')
const { diffHtml } = require('specpress/lib/md2html/htmlDiff')
const { pickVersions, collectFilesFromUris, collectFilesFromCommitUris, insertOmittedMarkers, formatExportTimestamp, showExportNotification } = require('./helpers')
const { selectCoverPage } = require('./coverPageSelector')

/**
 * Handles the "Export Selected to HTML" command from the explorer context menu.
 * Supports exporting a single version or a diff between two versions.
 */
async function exportHtml(state, config, extensionDir, uri, allUris) {
  const uris = allUris || (uri ? [uri] : await vscode.window.showOpenDialog({
    canSelectMany: true,
    canSelectFiles: true,
    canSelectFolders: true,
    filters: { 'Markdown': ['md', 'markdown', 'asn'] }
  }))
  if (!uris) return

  let repoRoot
  try {
    const firstPath = uris[0].fsPath
    repoRoot = getRepoRoot(fs.statSync(firstPath).isDirectory() ? firstPath : path.dirname(firstPath))
  } catch (e) {
    repoRoot = null
  }

  let commitRef = null
  let baselineRef = null
  if (repoRoot) {
    const versions = await pickVersions(
      repoRoot,
      'Select version for HTML export',
      'Compare against (select to export as HTML diff, or choose None to skip)'
    )
    if (versions === null) return
    const base = versions[0]
    commitRef = base.shortHash ? { repoRoot, commit: base.commitInput, shortHash: base.shortHash } : null
    const compare = versions.length > 1 ? versions[1] : null
    if (compare) {
      baselineRef = compare.shortHash
        ? { repoRoot, commit: compare.commitInput, shortHash: compare.shortHash }
        : 'local'
    }
  }

  const shortHash = commitRef ? commitRef.shortHash : null
  const commitInput = commitRef ? commitRef.commit : null
  const isDiff = baselineRef !== null
  const compareCommit = baselineRef === 'local' ? '' : (baselineRef ? baselineRef.commit : null)
  const compareShortHash = baselineRef === 'local' ? 'local' : (baselineRef ? baselineRef.shortHash : null)

  const specRoot = config.findSpecRootFor(uris[0].fsPath)
  const sectionSpecRoot = config.getSpecRootForFile(uris[0].fsPath)

  const coverPageChoice = await selectCoverPage(config, specRoot)
  if (!coverPageChoice) return

  const frontPageData = coverPageChoice.type === 'standard' ? coverPageChoice.frontPage : null
  const crCoverPageData = coverPageChoice.type === 'cr' ? coverPageChoice.crData : null

  const files = shortHash
    ? collectFilesFromCommitUris(repoRoot, uris, commitInput)
    : collectFilesFromUris(uris)
  if (files.length === 0) {
    vscode.window.showErrorMessage(shortHash ? `No markdown or ASN.1 files found in ${commitInput}` : 'No markdown or ASN.1 files found in selection')
    return
  }

  const ts = formatExportTimestamp()
  let defaultName
  if (isDiff) {
    const baseLabel = shortHash || 'local'
    const compareLabel = compareShortHash || 'local'
    defaultName = `${ts} DIFF_${baseLabel}_vs_${compareLabel}.html`
  } else {
    defaultName = shortHash ? `${ts} Export_${shortHash}.html` : `${ts} Export.html`
  }

  const saveUri = await vscode.window.showSaveDialog({
    filters: { 'HTML': ['html'] },
    defaultUri: vscode.Uri.file(path.join(config.getExportFolder(state.lastExportFolder), defaultName))
  })
  if (!saveUri) return
  state.lastExportFolder = path.dirname(saveUri.fsPath)

  try {
    let imageCount = 0
    const label = shortHash ? `${commitInput} (${shortHash})` : 'local files'
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting HTML from ${label}...`, cancellable: false },
      async () => {
        let baseResolver = null
        if (shortHash && specRoot) {
          baseResolver = createCommitResolver(repoRoot, specRoot, commitInput)
        }

        const readFile = baseResolver ? (f) => baseResolver.readFile(f, 'utf8') : undefined
        let content = concatenateFiles(files, readFile, sectionSpecRoot)
        if (specRoot && !config.isSpecRootSelection(uris)) {
          const allSpecFiles = collectFiles([specRoot])
          if (files.length < allSpecFiles.length) {
            content = insertOmittedMarkers(content, files, allSpecFiles)
          }
        }

        const handler = new Md2Html({
          css: config.loadCss(extensionDir),
          mermaidConfig: config.loadMermaidConfig(),
          specRootPath: sectionSpecRoot
        })

        const exportDir = path.dirname(saveUri.fsPath)
        const mediaDir = path.join(exportDir, 'media')
        fs.mkdirSync(mediaDir, { recursive: true })

        let compareResolver = null
        let html
        if (isDiff) {
          if (compareCommit && specRoot) {
            compareResolver = createCommitResolver(repoRoot, specRoot, compareCommit)
          } else if (specRoot && repoRoot) {
            compareResolver = createLocalResolver(repoRoot, specRoot)
          }

          const compareFiles = compareCommit
            ? collectFilesFromCommitUris(repoRoot, uris, compareCommit)
            : collectFilesFromUris(uris)
          const compareReadFile = compareResolver && compareCommit ? (f) => compareResolver.readFile(f, 'utf8') : undefined
          const compareContent = concatenateFiles(compareFiles, compareReadFile, sectionSpecRoot)

          html = handler.renderMarkdownForExport(compareContent, sectionSpecRoot, frontPageData, crCoverPageData)
          const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/)
          if (bodyMatch) {
            const diffBody = diffHtml({
              baselineContent: content,
              currentContent: compareContent,
              handler,
              baselineFileResolver: baseResolver,
              currentFileResolver: compareResolver,
              frontPageData,
              crCoverPageData,
            })
            html = html.replace(bodyMatch[0], '<body>' + diffBody + '</body>')
          }
        } else {
          html = handler.renderMarkdownForExport(content, sectionSpecRoot, frontPageData, crCoverPageData)
        }

        html = html.replace(/\s*data-source-line="\d+"/g, '')
        html = html.replace(/\s*data-source-file="[^"]*"/g, '')

        // Copy images to media/.
        // For diff exports: images inside diff-del-block are from the baseline (old) version
        // and must be read via baseResolver. All other images are from the current version.
        // Using a suffix '_old' for baseline images ensures changed images get distinct filenames.
        const copiedImages = new Map()

        const resolveImagePath = (src) => {
          if (path.isAbsolute(src)) return src
          if (specRoot) {
            const c = path.join(path.dirname(specRoot), src)
            if (fs.existsSync(c) || (baseResolver && baseResolver.exists(c)) || (compareResolver && compareResolver.exists(c))) return c
          }
          for (const f of files) {
            const c = path.join(path.dirname(f), src)
            if (fs.existsSync(c)) return c
          }
          return null
        }

        const copyImage = (imagePath, resolver, suffix) => {
          const key = imagePath + suffix
          if (copiedImages.has(key)) return copiedImages.get(key)
          const ext = path.extname(imagePath)
          const rel = specRoot ? path.relative(path.dirname(specRoot), imagePath) : path.basename(imagePath)
          const safeName = rel.slice(0, -ext.length).replace(/[\\/.]+/g, '_').replace(/^_+/, '') + suffix + ext
          try {
            let data
            if (resolver && resolver.exists(imagePath)) {
              data = resolver.readFile(imagePath)
            } else {
              data = fs.readFileSync(imagePath)
            }
            fs.writeFileSync(path.join(mediaDir, safeName), data)
            copiedImages.set(key, safeName)
            return safeName
          } catch (e) { return null }
        }

        // Pass 1: images inside diff-del-block → read from baseResolver, suffix '_old'
        html = html.replace(/(<div class="diff-del-block"[^>]*>)([\s\S]*?)(<\/div>)/g, (block, open, inner, close) => {
          const newInner = inner.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/g, (match, before, src, after) => {
            if (/^(https?:|data:)/.test(src)) return match
            const imagePath = resolveImagePath(src)
            if (!imagePath) return match
            const safeName = copyImage(imagePath, baseResolver, '_old')
            return safeName ? `<img${before}src="media/${safeName}"${after}>` : match
          })
          return open + newInner + close
        })

        // Pass 2: all remaining images → read from compareResolver (or fs), no suffix
        html = html.replace(/<img([^>]*?)src="([^"]+)"([^>]*?)>/g, (match, before, src, after) => {
          if (/^(https?:|data:)/.test(src)) return match
          const imagePath = resolveImagePath(src)
          if (!imagePath) return match
          const resolver = (compareResolver && compareResolver.exists(imagePath)) ? compareResolver
            : (baseResolver && baseResolver.exists(imagePath)) ? baseResolver : null
          const safeName = copyImage(imagePath, resolver, '')
          return safeName ? `<img${before}src="media/${safeName}"${after}>` : match
        })

        fs.writeFileSync(saveUri.fsPath, html)
        imageCount = copiedImages.size
      }
    )

    const exportLabel = isDiff
      ? `HTML diff (${shortHash || 'local'} vs ${compareShortHash || 'local'})`
      : `HTML`
    showExportNotification(
      formatExportMessage(exportLabel, files.length, imageCount, shortHash ? `hash: ${shortHash}` : undefined),
      path.dirname(saveUri.fsPath)
    )
  } catch (e) {
    vscode.window.showErrorMessage(`HTML export failed: ${e.message}`)
  }
}

module.exports = { exportHtml }
