const path = require('path')
const { concatenateFiles } = require('specpress/lib/common/specProcessor')
const { diffHtml } = require('specpress/lib/md2html/htmlDiff')

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
  if (!state.changeTrackingCommit || !state.changeTrackingBaseline) return currentHtml

  const normPath = (p) => p.replace(/\\/g, '/').toLowerCase()

  // -- Step 1: Retrieve baseline content from the cached git commit --
  let baselineContent = ''
  if (filePath) {
    baselineContent = state.changeTrackingBaseline.get(filePath) || ''
    if (!baselineContent) {
      const target = normPath(filePath)
      for (const [key, val] of state.changeTrackingBaseline) {
        if (normPath(key) === target) { baselineContent = val; break }
      }
    }
  } else if (files) {
    const specRoot = renderOpts.specRoot || ''
    const getBaseline = (f) => {
      if (state.changeTrackingBaseline.has(f)) return state.changeTrackingBaseline.get(f)
      const target = normPath(f)
      for (const [key, val] of state.changeTrackingBaseline) {
        if (normPath(key) === target) return val
      }
      return ''
    }
    const baselineFiles = files.filter(f => getBaseline(f) !== '')
    baselineContent = concatenateFiles(baselineFiles, getBaseline, specRoot)
  }

  if (!baselineContent) return currentHtml

  // -- Step 2: Resolve JsonTable links from the baseline cache --
  baselineContent = baselineContent.replace(/\r\n/g, '\n')
  baselineContent = baselineContent.replace(/\[JsonTable\]\(([^)]+\.json)\)/g, (match, jsonRelPath) => {
    try {
      const beforeMatch = baselineContent.substring(0, baselineContent.indexOf(match))
      const fileComment = beforeMatch.match(/<!-- FILE: (.+?) -->/g)
      const lastFile = fileComment ? fileComment[fileComment.length - 1].match(/<!-- FILE: (.+?) -->/)[1] : (filePath || (files && files[0]) || '')
      const dir = path.dirname(lastFile)
      const jsonPath = path.isAbsolute(jsonRelPath) ? jsonRelPath : path.join(dir, jsonRelPath)

      let baselineJson = state.changeTrackingBaseline.get(jsonPath) || null
      if (!baselineJson) {
        const target = normPath(jsonPath)
        for (const [key, val] of state.changeTrackingBaseline) {
          if (normPath(key) === target) { baselineJson = val; break }
        }
      }
      if (baselineJson) {
        return '```jsonTable\n' + baselineJson + '\n```'
      }
    } catch (e) { /* fall through */ }
    return match
  })

  // -- Step 3: Resolve baseline front page data from cache --
  const frontPageData = renderOpts.frontPageData || null
  const crCoverPageData = renderOpts.crCoverPageData || null
  let baselineFrontPageData = frontPageData
  if (frontPageData && !crCoverPageData) {
    const baselineFront = buildBaselineFrontPage(state, config, normPath)
    if (baselineFront !== null) baselineFrontPageData = baselineFront
  }

  // -- Step 4: Extract current body and strip source annotations for diffing --
  const bodyMatch = currentHtml.match(/<body>([\s\S]*)<\/body>/)
  if (!bodyMatch) return currentHtml

  // Strip ASN.1 source spans for clean diffing; keep data-source-line for scroll sync
  let cleanCurrentBody = bodyMatch[1]
  cleanCurrentBody = cleanCurrentBody.replace(/(<pre class="asn"[^>]*><code>)([\s\S]*?)(<\/code><\/pre>)/g, (m, open, innerContent, close) => {
    const fixed = innerContent
      .replace(/<span data-source-line="[^"]*"(?:\s+data-source-file="[^"]*")?>/g, '')
      .replace(/<\/span>\n/g, '\n')
      .replace(/<\/span>$/, '')
    return open + fixed + close
  })
  cleanCurrentBody = cleanCurrentBody.replace(/ data-source-file="[^"]*"/g, '')

  // -- Step 5: Call specpress diffHtml --
  const diffBody = diffHtml({
    baselineContent,
    currentContent: content,
    handler,
    specRoot: renderOpts.specRoot || '',
    frontPageData: baselineFrontPageData,
    crCoverPageData,
    baseDir: renderOpts.baseDir || null,
    currentBody: cleanCurrentBody
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
 * Retrieves baseline front page data from the git cache.
 */
function buildBaselineFrontPage(state, config, normPath) {
  const dataFile = config.frontPageData
  if (!dataFile) return null

  const targetName = normPath(path.basename(dataFile))
  let baselineDataJson = null
  for (const [key, val] of state.changeTrackingBaseline) {
    if (typeof val === 'string' && normPath(key).endsWith('/' + targetName)) {
      baselineDataJson = val
      break
    }
  }
  if (!baselineDataJson) return null

  try {
    return JSON.parse(baselineDataJson)
  } catch (e) {
    return null
  }
}

module.exports = { applyDiff }
