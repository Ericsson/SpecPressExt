const path = require('path')
const { concatenateFiles, collectFilesFromCommit, diffHtml } = require('specpress')

/**
 * Applies change tracking by diffing baseline vs current rendered HTML.
 * Delegates the actual diffing to specpress's diffHtml() function.
 *
 * @param {Object} state - StateManager instance.
 * @param {Object} handler - Md2Html handler instance.
 * @param {Object} config - ConfigLoader instance.
 * @param {string} currentHtml - Full rendered HTML of the current version.
 * @param {string} content - Current markdown content.
 * @param {string} filePath - Source file path (for single-file mode).
 * @param {string[]} [files] - All files (for multi-file mode).
 * @param {Object} renderOpts - { baseDir, specRoot, frontPageData, crCoverPageData }.
 * @returns {string} HTML with tracked changes, or original HTML if tracking disabled.
 */
function applyDiff(state, handler, config, currentHtml, content, filePath, files, renderOpts) {
  if (!state.changeTrackingCommit || !state.changeTrackingResolver) return currentHtml

  const resolver = state.changeTrackingResolver

  // -- Step 1: Retrieve baseline content --
  let baselineContent = ''
  if (filePath) {
    baselineContent = resolver.readFileOrNull(filePath, 'utf8') || ''
  } else if (files) {
    // Collect files from the baseline commit independently — don't filter current
    // file list, which misses renamed/deleted files from the baseline version.

    // Get all body files (md, asn, ...) from the baseline's FileResolver:
    let baselineFiles = resolver.listSpecFiles(true, true)

    // Filter to files in the current range (to handle renames/deletes)
    let firstCurrentFile = path.relative(state.currentResolver.specRoot, files[0])
    let lastCurrentFile = path.relative(state.currentResolver.specRoot, files[files.length - 1])
    baselineFiles = baselineFiles.filter(f => (
      f >= firstCurrentFile &&
      f <= lastCurrentFile)
    )

    // Concatenate baseline files (as they existed in the baseline commit):
    const baselineFilesAbsLocal = baselineFiles.map(f => path.join(resolver.specRootAbsLocal, f))

    // Concatenate and pre-process the selected baseline files of the specification
    baselineContent = concatenateFiles(baselineFilesAbsLocal, (f) => resolver.readFile(f, 'utf8'), resolver.specRootAbsLocal)
  }

  if (!baselineContent) return currentHtml

  // -- Step 2: Resolve JsonTable links from the baseline --
  baselineContent = baselineContent.replace(/\r\n/g, '\n')
  baselineContent = baselineContent.replace(/\[JsonTable\]\(([^)]+\.json)\)/g, (match, jsonRelPath, offset) => {
    try {
      const beforeMatch = baselineContent.substring(0, offset)
      const fileComment = beforeMatch.match(/<!-- FILE: (.+?) -->/g)
      const lastFile = fileComment ? fileComment[fileComment.length - 1].match(/<!-- FILE: (.+?) -->/)[1] : (filePath || (files && files[0]) || '')
      const dir = path.dirname(lastFile)
      const jsonPath = path.isAbsolute(jsonRelPath) ? jsonRelPath : path.join(dir, jsonRelPath)
      const baselineJson = resolver.readFileOrNull(jsonPath, 'utf8')
      if (baselineJson) return '```jsonTable\n' + baselineJson + '\n```'
    } catch (e) { /* fall through */ }
    return match
  })

  // -- Step 3: Resolve baseline front page data --
  const frontPageData = renderOpts.frontPageData || null
  const crCoverPageData = renderOpts.crCoverPageData || null
  let baselineFrontPageData = frontPageData
  if (frontPageData && !crCoverPageData) {
    const baselineFront = buildBaselineFrontPage(resolver, config)
    if (baselineFront !== null) baselineFrontPageData = baselineFront
  }

  // -- Step 4: Call specpress diffHtml --
  // Pass handler.fileResolver as currentFileResolver so diffHtml renders both
  // sides with absolute paths for hashing, then applies resolveImageUri at
  // restore time (webview URIs for preview, absolute paths for export).
  const bodyMatch = currentHtml.match(/<body>([\s\S]*)<\/body>/)
  if (!bodyMatch) return currentHtml

  const diffBody = diffHtml({
    baselineContent,
    currentContent: content,
    handler,
    baselineFileResolver: resolver,
    currentFileResolver: handler.fileResolver || null,
    frontPageData: baselineFrontPageData,
    crCoverPageData,
  })

  // -- Step 6: Re-inject data-source-file attributes for scroll sync --
  let finalBody = diffBody
  const fileMarkerRe = /<!-- FILE: (.+?) -->/g
  let match
  let lastFileEndPos = 0
  const fileSegments = []
  while ((match = fileMarkerRe.exec(finalBody)) !== null) {
    if (lastFileEndPos > 0) {
      fileSegments.push({ start: lastFileEndPos, end: match.index, file: fileSegments[fileSegments.length - 1].file })
    }
    lastFileEndPos = match.index + match[0].length
    fileSegments.push({ start: lastFileEndPos, end: finalBody.length, file: match[1] })
  }
  for (let i = fileSegments.length - 1; i >= 0; i--) {
    const seg = fileSegments[i]
    let segment = finalBody.substring(seg.start, seg.end)
    segment = segment.replace(/(<(?:h[1-6]|p|li|td|th|div|pre)[^>]*)(>)/g, (m, tag, close) => {
      if (tag.includes('data-source-file=')) return m
      return `${tag} data-source-file="${seg.file}"${close}`
    })
    finalBody = finalBody.substring(0, seg.start) + segment + finalBody.substring(seg.end)
  }

  return currentHtml.replace(bodyMatch[0], '<body>' + finalBody + '</body>')
}

/**
 * Retrieves baseline front page data from the resolver.
 */
function buildBaselineFrontPage(resolver, config) {
  const dataFile = config.frontPageData
  if (!dataFile) return null
  const baselineDataJson = resolver.readFileOrNull(dataFile, 'utf8')
  if (!baselineDataJson) return null
  try {
    return JSON.parse(baselineDataJson)
  } catch (e) {
    return null
  }
}

module.exports = { applyDiff }
