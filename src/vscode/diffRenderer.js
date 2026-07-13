const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const HtmlDiff = require('htmldiff-js')
const { concatenateFiles } = require('specpress/lib/common/specProcessor')

/**
 * Applies change tracking by diffing rendered HTML of baseline vs current.
 * Uses htmldiff-js for word-level HTML diffing that preserves all formatting.
 *
 * @param {Object} state - StateManager instance.
 * @param {Object} handler - Md2Html handler instance.
 * @param {Object} config - ConfigLoader instance.
 * @param {string} currentHtml - Full rendered HTML of the current version.
 * @param {string} content - Current markdown content (for baseline rendering).
 * @param {string} filePath - Source file path (for single-file mode).
 * @param {string[]} [files] - All files (for multi-file mode).
 * @param {Object} renderOpts - { baseDir, specRoot, filePath, includeFrontPage } for rendering baseline.
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

  // -- Step 2: Prepare baseline content for rendering --
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

  // -- Step 3: Render baseline markdown to HTML --
  const frontPageData = renderOpts.frontPageData || null
  const crCoverPageData = renderOpts.crCoverPageData || null
  let baselineFrontPageData = frontPageData
  if (frontPageData && !crCoverPageData) {
    const baselineFront = buildBaselineFrontPage(state, config, normPath)
    if (baselineFront !== null) baselineFrontPageData = baselineFront
  }
  const baselineBody = handler.renderBody(
    baselineContent, false,
    renderOpts.baseDir || null,
    renderOpts.filePath || null,
    renderOpts.specRoot || null,
    baselineFrontPageData,
    crCoverPageData
  )

  // -- Step 4: Replace images and mermaid blocks with stable placeholders --
  const bodyMatch = currentHtml.match(/<body>([\s\S]*)<\/body>/)
  if (!bodyMatch) return currentHtml
  const currentBody = bodyMatch[1]

  const placeholders = new Map()
  const hashContent = (data) => crypto.createHash('md5').update(data).digest('hex').substring(0, 12)
  const mermaidSource = (preTag) => preTag.replace(/<pre[^>]*>/, '').replace(/<\/pre>/, '').trim().replace(/\r\n/g, '\n')

  const replaceBlocks = (html, version) => {
    html = html.replace(/<pre class="mermaid"[^>]*>[\s\S]*?<\/pre>/g, (match) => {
      const hash = hashContent(mermaidSource(match))
      const id = `MERMAID_${hash}`
      if (!placeholders.has(id)) placeholders.set(id, {})
      placeholders.get(id)[version] = match
      return ` ${id} `
    })
    html = html.replace(/<img[^>]*>/g, (match) => {
      const src = (match.match(/src="([^"]+)"/) || [])[1] || ''
      const decodedSrc = decodeURIComponent(src)
      const filename = decodedSrc.split('/').pop().split('?')[0]
      const id = `IMG_${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`
      if (!placeholders.has(id)) placeholders.set(id, { filename })
      const entry = placeholders.get(id)
      entry[version] = match
      if (version === 'current') {
        try {
          const urlPath = decodedSrc.replace(/^https?:\/\/[^/]+\//, '')
          const imgPath = decodeURIComponent(urlPath)
          if (imgPath && fs.existsSync(imgPath)) {
            entry.currentHash = hashContent(fs.readFileSync(imgPath))
          }
        } catch (e) { /* no hash */ }
      } else {
        for (const [key, val] of state.changeTrackingBaseline) {
          if (normPath(key).endsWith('/' + normPath(filename))) {
            entry.baselineHash = hashContent(Buffer.isBuffer(val) ? val : Buffer.from(val))
            break
          }
        }
      }
      return ` ${id} `
    })
    return html
  }

  const processedBaseline = replaceBlocks(baselineBody, 'baseline')
  let processedCurrent = replaceBlocks(currentBody, 'current')

  // Strip data-source-line/file attributes for consistent diffing
  processedCurrent = processedCurrent.replace(/(<pre class="asn"[^>]*><code>)([\s\S]*?)(<\/code><\/pre>)/g, (match, open, content, close) => {
    const fixed = content
      .replace(/<span data-source-line="[^"]*"(?:\s+data-source-file="[^"]*")?>/g, '')
      .replace(/<\/span>\n/g, '\n')
      .replace(/<\/span>$/, '')
    return open + fixed + close
  })
  processedCurrent = processedCurrent.replace(/ data-source-line="[^"]*"/g, '')
  processedCurrent = processedCurrent.replace(/ data-source-file="[^"]*"/g, '')

  // -- Step 5: Run word-level HTML diff --
  let diffedBody = HtmlDiff.default.execute(processedBaseline, processedCurrent)

  // Re-inject data-source-file attributes from FILE markers
  const fileMarkerRe = /<!-- FILE: (.+?) -->/g
  let match
  let lastFileEndPos = 0
  const fileSegments = []
  while ((match = fileMarkerRe.exec(diffedBody)) !== null) {
    if (lastFileEndPos > 0) {
      fileSegments.push({ start: lastFileEndPos, end: match.index, file: fileSegments[fileSegments.length - 1].file })
    }
    lastFileEndPos = match.index + match[0].length
    fileSegments.push({ start: lastFileEndPos, end: diffedBody.length, file: match[1] })
  }
  for (let i = fileSegments.length - 1; i >= 0; i--) {
    const seg = fileSegments[i]
    let segment = diffedBody.substring(seg.start, seg.end)
    segment = segment.replace(/(<(?:h[1-6]|p|li|td|th|div|pre)[^>]*)(>)/g, (m, tag, close) => {
      if (tag.includes('data-source-file=')) return m
      return `${tag} data-source-file="${seg.file}"${close}`
    })
    diffedBody = diffedBody.substring(0, seg.start) + segment + diffedBody.substring(seg.end)
  }

  // -- Step 6: Restore placeholders with appropriate diff visualization --
  for (const [id, entry] of placeholders) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    const delRe = new RegExp(`<del[^>]*>[^<]*?${escaped}[^<]*?<\\/del>`, 'g')
    diffedBody = diffedBody.replace(delRe, () => {
      const html = entry.baseline || entry.current || ''
      const label = id.startsWith('MERMAID_') ? 'Deleted figure:' : 'Deleted image:'
      return `<div class="diff-del-block"><p class="diff-label">${label}</p>${html}</div>`
    })

    const insRe = new RegExp(`<ins[^>]*>[^<]*?${escaped}[^<]*?<\\/ins>`, 'g')
    diffedBody = diffedBody.replace(insRe, () => {
      const html = entry.current || entry.baseline || ''
      const label = id.startsWith('MERMAID_') ? 'New figure:' : 'New image:'
      return `<div class="diff-ins-block"><p class="diff-label">${label}</p>${html}</div>`
    })

    const plainRe = new RegExp(` ${escaped} `, 'g')
    diffedBody = diffedBody.replace(plainRe, () => {
      if (id.startsWith('IMG_') && entry.baselineHash && entry.currentHash && entry.baselineHash !== entry.currentHash) {
        const currentImg = entry.current || ''
        let oldImg = ''
        const targetName = normPath(entry.filename || '')
        for (const [key, val] of state.changeTrackingBaseline) {
          if (Buffer.isBuffer(val) && normPath(key).endsWith('/' + targetName)) {
            const ext = key.split('.').pop().toLowerCase()
            const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
            const b64 = val.toString('base64')
            const alt = (currentImg.match(/alt="([^"]*)"/) || [])[1] || ''
            oldImg = `<img src="data:${mime};base64,${b64}" alt="${alt}">`
            break
          }
        }
        if (!oldImg) oldImg = currentImg
        return `<div class="diff-del-block"><p class="diff-label">Old image:</p>${oldImg}</div><div class="diff-ins-block"><p class="diff-label">New image:</p>${currentImg}</div>`
      }
      if (id.startsWith('MERMAID_') && entry.baseline && entry.current && mermaidSource(entry.baseline) !== mermaidSource(entry.current)) {
        return `<div class="diff-del-block"><p class="diff-label">Deleted figure:</p>${entry.baseline}</div><div class="diff-ins-block"><p class="diff-label">New figure:</p>${entry.current}</div>`
      }
      return entry.current || entry.baseline || ` ${id} `
    })
  }

  return currentHtml.replace(bodyMatch[0], '<body>' + diffedBody + '</body>')
}

/**
 * Builds front page HTML from the baseline cache's front page data JSON.
 * @returns {string|null} Rendered front page HTML, or null if not available.
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
