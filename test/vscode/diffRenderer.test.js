const assert = require('assert')
const path = require('path')
const Module = require('module')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failed++
  }
}

// ── Mock vscode (required by specpress/lib/md2html/frontPage) ──
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode'
  return origResolve.call(this, request, ...args)
}
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} }

const { applyDiff } = require('../../src/vscode/diffRenderer')

// ── Helpers ──

/** Creates a minimal state object with change tracking enabled. */
function makeState(baselineMap) {
  return {
    changeTrackingCommit: 'abc123',
    changeTrackingBaseline: new Map(Object.entries(baselineMap))
  }
}

/** Creates a minimal state with change tracking disabled. */
function makeDisabledState() {
  return { changeTrackingCommit: null, changeTrackingBaseline: null }
}

/** Creates a mock handler that wraps content in <p> tags. */
function makeHandler(opts = {}) {
  return {
    frontPageHtml: opts.frontPageHtml || null,
    renderBody(content, forPreview, baseDir, filePath, specRoot, includeFrontPage) {
      // Simple renderer: wrap each line in <p>
      const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('<!--'))
      return lines.map(l => `<p>${l.trim()}</p>`).join('\n')
    }
  }
}

/** Creates a minimal config. */
function makeConfig(opts = {}) {
  return { frontPageData: opts.frontPageData || null }
}

/** Wraps body content in a full HTML document. */
function wrapHtml(body) {
  return `<html><head></head><body>${body}</body></html>`
}

// ── Tests ──

console.log('applyDiff - disabled')

test('returns original HTML when change tracking is disabled', () => {
  const state = makeDisabledState()
  const handler = makeHandler()
  const config = makeConfig()
  const html = wrapHtml('<p>hello</p>')
  const result = applyDiff(state, handler, config, html, '# hello', '/file.md', null, {})
  assert.strictEqual(result, html)
})

test('returns original HTML when changeTrackingBaseline is null', () => {
  const state = { changeTrackingCommit: 'abc', changeTrackingBaseline: null }
  const handler = makeHandler()
  const config = makeConfig()
  const html = wrapHtml('<p>hello</p>')
  const result = applyDiff(state, handler, config, html, '# hello', '/file.md', null, {})
  assert.strictEqual(result, html)
})

console.log('\napplyDiff - single file mode')

test('returns original HTML when baseline content is empty', () => {
  const state = makeState({})
  const handler = makeHandler()
  const config = makeConfig()
  const html = wrapHtml('<p>hello</p>')
  const result = applyDiff(state, handler, config, html, 'hello', '/file.md', null, { baseDir: '/' })
  assert.strictEqual(result, html)
})

test('detects text insertion (new content not in baseline)', () => {
  const state = makeState({ '/file.md': 'old text' })
  const handler = makeHandler()
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>old text</p>\n<p>new text</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'old text\nnew text', '/file.md', null, { baseDir: '/' })
  assert.ok(result.includes('<ins'), 'should contain <ins> tag for insertion')
  assert.ok(result.includes('new text'), 'should contain the new text')
})

test('detects text deletion (baseline content removed)', () => {
  const state = makeState({ '/file.md': 'line one\nline two' })
  const handler = makeHandler()
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>line one</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'line one', '/file.md', null, { baseDir: '/' })
  assert.ok(result.includes('<del'), 'should contain <del> tag for deletion')
  assert.ok(result.includes('line two'), 'should contain the deleted text')
})

test('no diff markers when content is unchanged', () => {
  const state = makeState({ '/file.md': 'same content' })
  const handler = makeHandler()
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>same content</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'same content', '/file.md', null, { baseDir: '/' })
  assert.ok(!result.includes('<ins'), 'should not contain <ins>')
  assert.ok(!result.includes('<del'), 'should not contain <del>')
})

test('finds baseline via case-insensitive path matching', () => {
  const state = makeState({ 'C:\\Repo\\File.md': 'baseline' })
  const handler = makeHandler()
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>modified</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'modified', 'c:\\repo\\file.md', null, { baseDir: '/' })
  // Should find the baseline (case-insensitive) and produce a diff
  assert.ok(result.includes('<ins') || result.includes('<del'), 'should detect changes via case-insensitive lookup')
})

console.log('\napplyDiff - multi-file mode')

test('concatenates baseline files for multi-file diff', () => {
  const state = makeState({
    '/a.md': 'alpha',
    '/b.md': 'beta'
  })
  const handler = makeHandler()
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>alpha</p>\n<p>beta modified</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'alpha\nbeta modified', null, ['/a.md', '/b.md'], { baseDir: '/', specRoot: '' })
  assert.ok(result.includes('<ins') || result.includes('<del'), 'should detect changes in multi-file mode')
})

test('skips files not in baseline for multi-file mode', () => {
  const state = makeState({ '/a.md': 'alpha' })
  const handler = makeHandler()
  const config = makeConfig()
  // /b.md is new (not in baseline) — only /a.md has baseline
  const currentHtml = wrapHtml('<p>alpha</p>\n<p>brand new</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'alpha\nbrand new', null, ['/a.md', '/b.md'], { baseDir: '/', specRoot: '' })
  // Should still produce output (baseline only has /a.md content)
  assert.ok(result.includes('<body>'))
})

console.log('\napplyDiff - mermaid placeholders')

test('unchanged mermaid block is restored without diff markers', () => {
  const mermaidCode = 'graph TD\n  A-->B'
  const mermaidHtml = `<pre class="mermaid">${mermaidCode}</pre>`
  const state = makeState({ '/file.md': `\`\`\`mermaid\n${mermaidCode}\n\`\`\`` })
  // Handler renders mermaid as <pre class="mermaid">
  const handler = {
    frontPageHtml: null,
    renderBody(content) {
      return mermaidHtml
    }
  }
  const config = makeConfig()
  const currentHtml = wrapHtml(mermaidHtml)
  const result = applyDiff(state, handler, config, currentHtml, `\`\`\`mermaid\n${mermaidCode}\n\`\`\``, '/file.md', null, { baseDir: '/' })
  assert.ok(result.includes('class="mermaid"'), 'should restore mermaid block')
  assert.ok(!result.includes('diff-del-block'), 'should not show deleted figure')
  assert.ok(!result.includes('diff-ins-block'), 'should not show new figure')
})

test('new mermaid block shows as inserted', () => {
  const state = makeState({ '/file.md': 'no mermaid here' })
  const handler = {
    frontPageHtml: null,
    renderBody(content) {
      return '<p>no mermaid here</p>'
    }
  }
  const config = makeConfig()
  const mermaidHtml = '<pre class="mermaid">graph TD\n  A-->B</pre>'
  const currentHtml = wrapHtml(`<p>no mermaid here</p>\n${mermaidHtml}`)
  const result = applyDiff(state, handler, config, currentHtml, 'no mermaid here\n```mermaid\ngraph TD\n  A-->B\n```', '/file.md', null, { baseDir: '/' })
  assert.ok(result.includes('diff-ins-block') || result.includes('New figure'), 'should mark new mermaid as inserted')
})

test('removed mermaid block shows as deleted', () => {
  const mermaidHtml = '<pre class="mermaid">graph TD\n  A-->B</pre>'
  const state = makeState({ '/file.md': '```mermaid\ngraph TD\n  A-->B\n```' })
  const handler = {
    frontPageHtml: null,
    renderBody(content) {
      return mermaidHtml
    }
  }
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>mermaid removed</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'mermaid removed', '/file.md', null, { baseDir: '/' })
  assert.ok(result.includes('diff-del-block') || result.includes('Deleted figure'), 'should mark removed mermaid as deleted')
})

console.log('\napplyDiff - image placeholders')

test('unchanged image is restored without diff markers', () => {
  const imgTag = '<img src="photo.png" alt="test">'
  const state = makeState({ '/file.md': '![test](photo.png)' })
  const handler = {
    frontPageHtml: null,
    renderBody() { return imgTag }
  }
  const config = makeConfig()
  const currentHtml = wrapHtml(imgTag)
  const result = applyDiff(state, handler, config, currentHtml, '![test](photo.png)', '/file.md', null, { baseDir: '/' })
  assert.ok(result.includes('src="photo.png"'), 'should restore image')
  assert.ok(!result.includes('diff-del-block'), 'should not show deleted image')
  assert.ok(!result.includes('diff-ins-block'), 'should not show new image')
})

test('new image shows as inserted', () => {
  const state = makeState({ '/file.md': 'no image' })
  const handler = {
    frontPageHtml: null,
    renderBody() { return '<p>no image</p>' }
  }
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>no image</p>\n<img src="new.png" alt="new">')
  const result = applyDiff(state, handler, config, currentHtml, 'no image\n![new](new.png)', '/file.md', null, { baseDir: '/' })
  assert.ok(result.includes('diff-ins-block') || result.includes('New image'), 'should mark new image as inserted')
})

console.log('\napplyDiff - data-source-line stripping')

test('strips data-source-line attributes before diffing', () => {
  const state = makeState({ '/file.md': 'hello world' })
  const handler = {
    frontPageHtml: null,
    renderBody() { return '<p>hello world</p>' }
  }
  const config = makeConfig()
  // Current HTML has data-source-line (as in preview mode)
  const currentHtml = wrapHtml('<p data-source-line="0" data-source-file="/file.md">hello world</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'hello world', '/file.md', null, { baseDir: '/' })
  // Should not produce false diffs from the attributes
  assert.ok(!result.includes('<ins'), 'should not show insertion from attribute difference')
  assert.ok(!result.includes('<del'), 'should not show deletion from attribute difference')
})

test('strips ASN.1 per-line span wrappers before diffing', () => {
  const asnContent = 'MODULE DEFINITIONS ::= BEGIN\nEND'
  const state = makeState({ '/file.asn': asnContent })
  const handler = {
    frontPageHtml: null,
    renderBody() { return `<pre class="asn"><code>${asnContent}</code></pre>` }
  }
  const config = makeConfig()
  // Preview wraps each line in <span data-source-line="N">
  const previewAsn = `<pre class="asn"><code><span data-source-line="0">MODULE DEFINITIONS ::= BEGIN</span>\n<span data-source-line="1">END</span></code></pre>`
  const currentHtml = wrapHtml(previewAsn)
  const result = applyDiff(state, handler, config, currentHtml, asnContent, '/file.asn', null, { baseDir: '/' })
  assert.ok(!result.includes('<ins'), 'should not show insertion from span wrappers')
  assert.ok(!result.includes('<del'), 'should not show deletion from span wrappers')
})

console.log('\napplyDiff - CRLF normalization')

test('normalizes CRLF in baseline content', () => {
  const state = makeState({ '/file.md': 'line one\r\nline two' })
  const handler = makeHandler()
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>line one</p>\n<p>line two</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'line one\nline two', '/file.md', null, { baseDir: '/' })
  // CRLF vs LF should not produce false diffs
  assert.ok(!result.includes('<ins'), 'should not show insertion from line ending difference')
  assert.ok(!result.includes('<del'), 'should not show deletion from line ending difference')
})

console.log('\napplyDiff - no <body> tag')

test('returns original HTML when no <body> tag found', () => {
  const state = makeState({ '/file.md': 'baseline' })
  const handler = makeHandler()
  const config = makeConfig()
  const html = '<div>no body tag</div>'
  const result = applyDiff(state, handler, config, html, 'current', '/file.md', null, { baseDir: '/' })
  assert.strictEqual(result, html)
})

console.log('\napplyDiff - JsonTable inlining')

test('inlines JsonTable from baseline cache', () => {
  const jsonContent = '{"columns":[{"name":"A"}],"rows":[["1"]]}'
  const state = makeState({
    '/dir/file.md': '<!-- FILE: /dir/file.md -->\n[JsonTable](table.json)',
    '/dir/table.json': jsonContent
  })
  let renderedContent = ''
  const handler = {
    frontPageHtml: null,
    renderBody(content) {
      renderedContent = content
      return '<p>table</p>'
    }
  }
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>modified table</p>')
  applyDiff(state, handler, config, currentHtml, 'modified', '/dir/file.md', null, { baseDir: '/dir' })
  // The baseline content passed to renderBody should have the JsonTable inlined
  assert.ok(renderedContent.includes('```jsonTable'), 'should inline JsonTable as fenced code block')
  assert.ok(renderedContent.includes(jsonContent), 'should contain the JSON content')
})

console.log('\napplyDiff - FILE markers and data-source-file injection')

test('injects data-source-file from FILE comment markers', () => {
  const state = makeState({ '/a.md': 'alpha', '/b.md': 'beta' })
  const handler = {
    frontPageHtml: null,
    renderBody() { return '<!-- FILE: /a.md -->\n<p>alpha</p>\n<!-- FILE: /b.md -->\n<p>beta</p>' }
  }
  const config = makeConfig()
  const currentHtml = wrapHtml('<!-- FILE: /a.md -->\n<p>alpha</p>\n<!-- FILE: /b.md -->\n<p>beta changed</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'alpha\nbeta changed', null, ['/a.md', '/b.md'], { baseDir: '/', specRoot: '' })
  assert.ok(result.includes('data-source-file="/a.md"') || result.includes('data-source-file="/b.md"'), 'should inject data-source-file attributes')
})

console.log('\napplyDiff - front page and CR cover page in change tracking')

test('baseline uses standard front page when no crCoverPageData', () => {
  const state = makeState({ '/file.md': 'hello' })
  let baselineIncludedFront = false
  const handler = {
    frontPageHtml: '<div class="front-page">SPEC FRONT</div>',
    renderBody(content, forPreview, baseDir, filePath, specRoot, includeFrontPage, crCoverPageData) {
      if (includeFrontPage && !crCoverPageData) baselineIncludedFront = true
      const body = content.split('\n').filter(l => l.trim() && !l.startsWith('<!--')).map(l => `<p>${l.trim()}</p>`).join('\n')
      return includeFrontPage && !crCoverPageData ? '<div class="front-page">SPEC FRONT</div>' + body : body
    }
  }
  const config = makeConfig()
  const currentHtml = wrapHtml('<div class="front-page">SPEC FRONT</div><p>hello</p>')
  applyDiff(state, handler, config, currentHtml, 'hello', '/file.md', null, { baseDir: '/', includeFrontPage: true })
  assert.ok(baselineIncludedFront, 'baseline should include standard front page')
})

test('baseline uses CR cover page when crCoverPageData is provided', () => {
  const state = makeState({ '/file.md': 'hello' })
  let baselineCrData = null
  const handler = {
    frontPageHtml: '<div class="front-page">SPEC FRONT</div>',
    renderBody(content, forPreview, baseDir, filePath, specRoot, includeFrontPage, crCoverPageData) {
      baselineCrData = crCoverPageData
      const body = content.split('\n').filter(l => l.trim() && !l.startsWith('<!--')).map(l => `<p>${l.trim()}</p>`).join('\n')
      if (crCoverPageData) return '<div class="cr-cover">CR COVER</div>' + body
      if (includeFrontPage) return '<div class="front-page">SPEC FRONT</div>' + body
      return body
    }
  }
  const config = makeConfig()
  const crData = { Title: 'Test CR' }
  const currentHtml = wrapHtml('<div class="cr-cover">CR COVER</div><p>hello</p>')
  applyDiff(state, handler, config, currentHtml, 'hello', '/file.md', null, { baseDir: '/', includeFrontPage: true, crCoverPageData: crData })
  assert.deepStrictEqual(baselineCrData, crData, 'baseline should receive crCoverPageData')
})

test('CR cover page in both sides produces no diff markers', () => {
  const state = makeState({ '/file.md': 'same content' })
  const handler = {
    frontPageHtml: null,
    renderBody(content, forPreview, baseDir, filePath, specRoot, includeFrontPage, crCoverPageData) {
      const body = '<p>same content</p>'
      if (crCoverPageData) return '<div class="cr-cover">CR COVER PAGE</div>' + body
      return body
    }
  }
  const config = makeConfig()
  const crData = { Title: 'Test' }
  const currentHtml = wrapHtml('<div class="cr-cover">CR COVER PAGE</div><p>same content</p>')
  const result = applyDiff(state, handler, config, currentHtml, 'same content', '/file.md', null, { baseDir: '/', includeFrontPage: true, crCoverPageData: crData })
  assert.ok(!result.includes('<ins'), 'should not have insertions')
  assert.ok(!result.includes('<del'), 'should not have deletions')
})

test('standard front page does not appear when crCoverPageData is set', () => {
  const state = makeState({ '/file.md': 'hello' })
  let baselineUsedStandardFront = false
  const handler = {
    frontPageHtml: '<div class="front-page">SPEC FRONT</div>',
    renderBody(content, forPreview, baseDir, filePath, specRoot, includeFrontPage, crCoverPageData) {
      if (includeFrontPage && !crCoverPageData) baselineUsedStandardFront = true
      const body = content.split('\n').filter(l => l.trim() && !l.startsWith('<!--')).map(l => `<p>${l.trim()}</p>`).join('\n')
      if (crCoverPageData) return '<div class="cr-cover">CR</div>' + body
      return body
    }
  }
  const config = makeConfig()
  const crData = { Title: 'Test' }
  const currentHtml = wrapHtml('<div class="cr-cover">CR</div><p>hello</p>')
  applyDiff(state, handler, config, currentHtml, 'hello', '/file.md', null, { baseDir: '/', includeFrontPage: true, crCoverPageData: crData })
  assert.ok(!baselineUsedStandardFront, 'should not use standard front page when CR cover page is active')
})

test('no front page included when includeFrontPage is false', () => {
  const state = makeState({ '/file.md': 'hello' })
  let baselineIncludedFront = false
  const handler = {
    frontPageHtml: '<div class="front-page">SPEC FRONT</div>',
    renderBody(content, forPreview, baseDir, filePath, specRoot, includeFrontPage, crCoverPageData) {
      if (includeFrontPage) baselineIncludedFront = true
      return content.split('\n').filter(l => l.trim() && !l.startsWith('<!--')).map(l => `<p>${l.trim()}</p>`).join('\n')
    }
  }
  const config = makeConfig()
  const currentHtml = wrapHtml('<p>hello</p>')
  applyDiff(state, handler, config, currentHtml, 'hello', '/file.md', null, { baseDir: '/', includeFrontPage: false })
  assert.ok(!baselineIncludedFront, 'should not include front page when includeFrontPage is false')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
