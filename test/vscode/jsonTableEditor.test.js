const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
const Module = require('module')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failed++
  }
}

// ── Mock vscode module ────────────────────────────────────────

let mockWarnings = []
let mockErrors = []
let mockInfos = []

const vscodeMock = {
  workspace: {
    getConfiguration: () => ({ get: () => '' }),
    workspaceFolders: null,
    applyEdit: async () => true,
    onDidChangeTextDocument: () => ({ dispose: () => {} })
  },
  window: {
    showWarningMessage: (msg) => mockWarnings.push(msg),
    showErrorMessage: (msg) => mockErrors.push(msg),
    showInformationMessage: (msg) => mockInfos.push(msg),
    registerCustomEditorProvider: () => ({ dispose: () => {} }),
    activeTextEditor: null
  },
  commands: {
    executeCommand: async () => {}
  },
  Uri: {
    file: (p) => ({ fsPath: p })
  },
  WorkspaceEdit: class {
    replace() {}
  },
  Range: class {
    constructor() {}
  }
}

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode'
  return origResolve.call(this, request, ...args)
}
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeMock }

const { JsonTableEditorProvider } = require('../../src/vscode/jsonTableEditor')

function resetMocks() {
  mockWarnings = []
  mockErrors = []
  mockInfos = []
}

// ── renderCell tests ──────────────────────────────────────────

async function run() {
  console.log('renderCell')

  const provider = new JsonTableEditorProvider({})

  await test('renders null as (empty)', async () => {
    assert.ok(provider.renderCell(null).includes('(empty)'))
  })

  await test('renders undefined as (empty)', async () => {
    assert.ok(provider.renderCell(undefined).includes('(empty)'))
  })

  await test('renders empty string as nbsp', async () => {
    assert.strictEqual(provider.renderCell(''), '&nbsp;')
  })

  await test('renders ^ as merge above marker', async () => {
    const html = provider.renderCell('^')
    assert.ok(html.includes('merge above'))
  })

  await test('renders < as merge left marker', async () => {
    const html = provider.renderCell('<')
    assert.ok(html.includes('merge left'))
  })

  await test('renders bold markdown', async () => {
    const html = provider.renderCell('**bold**')
    assert.ok(html.includes('<strong>'))
    assert.ok(html.includes('bold'))
  })

  await test('renders italic markdown', async () => {
    const html = provider.renderCell('*italic*')
    assert.ok(html.includes('<em>'))
  })

  await test('renders line breaks', async () => {
    const html = provider.renderCell('line1\nline2')
    assert.ok(html.includes('<br>'))
  })

  await test('renders numbers as strings', async () => {
    const html = provider.renderCell(42)
    assert.ok(html.includes('42'))
  })

  // ── escapeAttr tests ──────────────────────────────────────────

  console.log('\nescapeAttr')

  await test('escapes ampersand', async () => {
    assert.ok(provider.escapeAttr('a&b').includes('&amp;'))
  })

  await test('escapes quotes', async () => {
    assert.ok(provider.escapeAttr('a"b').includes('&quot;'))
  })

  await test('escapes angle brackets', async () => {
    const result = provider.escapeAttr('<script>')
    assert.ok(result.includes('&lt;'))
    assert.ok(result.includes('&gt;'))
  })

  // ── getHtml tests ─────────────────────────────────────────────

  console.log('\ngetHtml')

  await test('generates valid HTML with table', async () => {
    const html = provider.getHtml({
      columns: [{ key: 'a', name: 'Col A' }],
      rows: [{ a: 'value' }]
    })
    assert.ok(html.includes('<!DOCTYPE html>'))
    assert.ok(html.includes('<table>'))
    assert.ok(html.includes('Col A'))
    assert.ok(html.includes('value'))
  })

  await test('includes column key in header', async () => {
    const html = provider.getHtml({
      columns: [{ key: 'mykey', name: 'My Column' }],
      rows: []
    })
    assert.ok(html.includes('mykey'))
    assert.ok(html.includes('My Column'))
  })

  await test('applies column alignment to cells', async () => {
    const html = provider.getHtml({
      columns: [{ key: 'a', name: 'A', align: 'center' }],
      rows: [{ a: 'val' }]
    })
    assert.ok(html.includes('text-align:center'))
  })

  await test('renders merged cells with rowspan', async () => {
    const html = provider.getHtml({
      columns: [{ key: 'a', name: 'A' }],
      rows: [{ a: 'top' }, { a: '^' }]
    })
    assert.ok(html.includes('rowspan="2"'))
  })

  await test('renders merged cells with colspan', async () => {
    const html = provider.getHtml({
      columns: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }],
      rows: [{ a: 'spans', b: '<' }]
    })
    assert.ok(html.includes('colspan="2"'))
  })

  await test('includes alignment dropdown in header', async () => {
    const html = provider.getHtml({
      columns: [{ key: 'a', name: 'A', align: 'right' }],
      rows: []
    })
    assert.ok(html.includes('align-select'))
    assert.ok(html.includes('selected'))
  })

  await test('includes mergeOnAbsence dropdown in header', async () => {
    const html = provider.getHtml({
      columns: [{ key: 'a', name: 'A', mergeOnAbsence: 'above' }],
      rows: []
    })
    assert.ok(html.includes('moa-select'))
  })

  await test('handles empty data gracefully', async () => {
    const html = provider.getHtml({ columns: [], rows: [] })
    assert.ok(html.includes('<table>'))
  })

  await test('includes KaTeX CSS', async () => {
    const html = provider.getHtml({ columns: [], rows: [] })
    assert.ok(html.includes('.katex'))
  })

  await test('includes 3gpp CSS', async () => {
    const html = provider.getHtml({ columns: [], rows: [] })
    assert.ok(html.includes('font-family'))
  })

  await test('script section parses as valid JavaScript', async () => {
    const html = provider.getHtml({
      columns: [{ key: 'a', name: 'A' }],
      rows: [{ a: 'test' }]
    })
    const m = html.match(/<script>([\s\S]*)<\/script>/)
    assert.ok(m, 'should have a script tag')
    const preamble = 'const acquireVsCodeApi=()=>({postMessage:()=>{}});const document={getElementById:()=>({}),querySelector:()=>({addEventListener:()=>{}}),querySelectorAll:()=>([]),addEventListener:()=>{}};const window={addEventListener:()=>{}};'
    try {
      new Function(preamble + m[1])
    } catch (e) {
      assert.fail('Script has syntax error: ' + e.message)
    }
  })

  // ── openEditor tests ──────────────────────────────────────────

  console.log('\nopenEditor')

  await test('rejects non-JsonTable JSON', async () => {
    resetMocks()
    const tmpFile = path.join(os.tmpdir(), `test_notjt_${Date.now()}.json`)
    fs.writeFileSync(tmpFile, '{"name": "not a table"}')
    try {
      await JsonTableEditorProvider.openEditor(vscodeMock, { fsPath: tmpFile })
      assert.strictEqual(mockWarnings.length, 1)
      assert.ok(mockWarnings[0].includes('does not appear'))
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  await test('accepts valid JsonTable JSON', async () => {
    resetMocks()
    const tmpFile = path.join(os.tmpdir(), `test_jt_${Date.now()}.json`)
    fs.writeFileSync(tmpFile, '{"columns": [{"key":"a","name":"A"}], "rows": []}')
    try {
      await JsonTableEditorProvider.openEditor(vscodeMock, { fsPath: tmpFile })
      assert.strictEqual(mockWarnings.length, 0)
      assert.strictEqual(mockErrors.length, 0)
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  await test('shows error for invalid JSON', async () => {
    resetMocks()
    const tmpFile = path.join(os.tmpdir(), `test_bad_${Date.now()}.json`)
    fs.writeFileSync(tmpFile, 'not json')
    try {
      await JsonTableEditorProvider.openEditor(vscodeMock, { fsPath: tmpFile })
      assert.strictEqual(mockErrors.length, 1)
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })

  await test('shows error when no URI provided', async () => {
    resetMocks()
    vscodeMock.window.activeTextEditor = null
    await JsonTableEditorProvider.openEditor(vscodeMock, null)
    assert.strictEqual(mockErrors.length, 1)
  })

  // ── openOrCreate tests ────────────────────────────────────────

  console.log('\nopenOrCreate')

  await test('creates new file from JsonTable link', async () => {
    resetMocks()
    const tmpDir = path.join(os.tmpdir(), `test_create_${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const mdFile = path.join(tmpDir, 'test.md')
    fs.writeFileSync(mdFile, '[JsonTable](assets/new.json)\n')
    const jsonPath = path.join(tmpDir, 'assets', 'new.json')

    vscodeMock.window.activeTextEditor = {
      document: {
        languageId: 'markdown',
        uri: { fsPath: mdFile },
        lineAt: () => ({ text: '[JsonTable](assets/new.json)' })
      },
      selection: { active: { line: 0 } }
    }

    try {
      await JsonTableEditorProvider.openOrCreate(vscodeMock)
      assert.ok(fs.existsSync(jsonPath), 'JSON file should be created')
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      assert.ok(data.columns, 'should have columns')
      assert.ok(data.rows, 'should have rows')
      assert.strictEqual(mockInfos.length, 1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true })
    }
  })

  await test('shows error when not on a JsonTable link', async () => {
    resetMocks()
    vscodeMock.window.activeTextEditor = {
      document: {
        languageId: 'markdown',
        uri: { fsPath: '/test.md' },
        lineAt: () => ({ text: 'just regular text' })
      },
      selection: { active: { line: 0 } }
    }
    await JsonTableEditorProvider.openOrCreate(vscodeMock)
    assert.strictEqual(mockErrors.length, 1)
    assert.ok(mockErrors[0].includes('No [JsonTable]'))
  })

  await test('shows error when not in markdown file', async () => {
    resetMocks()
    vscodeMock.window.activeTextEditor = {
      document: { languageId: 'json', uri: { fsPath: '/test.json' } },
      selection: { active: { line: 0 } }
    }
    await JsonTableEditorProvider.openOrCreate(vscodeMock)
    assert.strictEqual(mockErrors.length, 1)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
