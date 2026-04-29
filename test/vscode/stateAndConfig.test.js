const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')
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

// ── Mock vscode module ────────────────────────────────────────

let mockConfig = {}
let mockWsRoot = ''
let mockWarnings = []

const vscodeMock = {
  workspace: {
    getConfiguration: (section) => ({
      get: (key, def) => mockConfig[key] !== undefined ? mockConfig[key] : def
    }),
    get workspaceFolders() {
      return mockWsRoot ? [{ uri: { fsPath: mockWsRoot } }] : null
    }
  },
  window: {
    showWarningMessage: (msg) => mockWarnings.push(msg)
  },
  Uri: {
    file: (p) => ({ fsPath: p })
  }
}

// Intercept require('vscode')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode'
  return origResolve.call(this, request, ...args)
}
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeMock }

// Now require the modules under test
const { StateManager } = require('../../src/vscode/stateManager')
const { ConfigLoader } = require('../../src/vscode/configLoader')

function resetMocks() {
  mockConfig = {}
  mockWsRoot = ''
  mockWarnings = []
}

// ── StateManager tests ────────────────────────────────────────

console.log('StateManager')

test('initial state has null panel and handler', () => {
  const s = new StateManager()
  assert.strictEqual(s.panel, null)
  assert.strictEqual(s.handler, null)
  assert.strictEqual(s.autoPreviewActive, false)
})

test('disposeListeners disposes and nulls listeners', () => {
  const s = new StateManager()
  let disposed = 0
  s.updatePreview = { dispose: () => disposed++ }
  s.scrollSync = { dispose: () => disposed++ }
  s.disposeListeners()
  assert.strictEqual(disposed, 2)
  assert.strictEqual(s.updatePreview, null)
  assert.strictEqual(s.scrollSync, null)
})

test('disposeListeners handles null listeners', () => {
  const s = new StateManager()
  s.disposeListeners() // should not throw
})

test('resetMultiFileState clears all multi-file fields', () => {
  const s = new StateManager()
  s.multiFileContent = 'content'
  s.multiFileBaseDir = '/dir'
  s.multiFilePaths = ['a.md']
  s.multiFileAllFiles = ['a.md', 'b.asn']
  s.resetMultiFileState()
  assert.strictEqual(s.multiFileContent, null)
  assert.strictEqual(s.multiFileBaseDir, null)
  assert.strictEqual(s.multiFilePaths, null)
  assert.strictEqual(s.multiFileAllFiles, null)
})

test('onPanelDisposed resets panel, autoPreview, listeners, and multi-file state', () => {
  const s = new StateManager()
  s.panel = {}
  s.autoPreviewActive = true
  s.multiFileContent = 'content'
  let disposed = 0
  s.updatePreview = { dispose: () => disposed++ }
  s.onPanelDisposed()
  assert.strictEqual(s.panel, null)
  assert.strictEqual(s.autoPreviewActive, false)
  assert.strictEqual(s.multiFileContent, null)
  assert.strictEqual(disposed, 1)
})

// ── ConfigLoader tests ────────────────────────────────────────

console.log('\nConfigLoader')

test('wsRoot returns empty string when no workspace folders', () => {
  resetMocks()
  const c = new ConfigLoader()
  assert.strictEqual(c.wsRoot, '')
})

test('wsRoot returns workspace folder path', () => {
  resetMocks()
  mockWsRoot = '/workspace'
  const c = new ConfigLoader()
  assert.strictEqual(c.wsRoot, '/workspace')
})

test('resolveSpecRoots returns empty array when not configured', () => {
  resetMocks()
  const c = new ConfigLoader()
  assert.deepStrictEqual(c.resolveSpecRoots(), [])
})

test('resolveSpecRoots resolves relative path to workspace root', () => {
  resetMocks()
  mockWsRoot = '/workspace'
  mockConfig.specificationRootPath = 'spec'
  const c = new ConfigLoader()
  const roots = c.resolveSpecRoots()
  assert.strictEqual(roots.length, 1)
  assert.ok(roots[0].endsWith('spec'))
})

test('resolveSpecRoots handles array of paths', () => {
  resetMocks()
  mockWsRoot = '/workspace'
  mockConfig.specificationRootPath = ['spec1', 'spec2']
  const c = new ConfigLoader()
  assert.strictEqual(c.resolveSpecRoots().length, 2)
})

test('resolveSpecRoots filters out paths outside workspace', () => {
  resetMocks()
  mockWsRoot = path.resolve('/workspace')
  mockConfig.specificationRootPath = ['spec', '../../outside']
  const c = new ConfigLoader()
  const roots = c.resolveSpecRoots()
  assert.strictEqual(roots.length, 1)
  assert.strictEqual(mockWarnings.length, 1)
  assert.ok(mockWarnings[0].includes('outside the workspace'))
})

test('resolveSpecRoots caches results', () => {
  resetMocks()
  mockWsRoot = '/workspace'
  mockConfig.specificationRootPath = 'spec'
  const c = new ConfigLoader()
  const r1 = c.resolveSpecRoots()
  mockConfig.specificationRootPath = 'other'
  const r2 = c.resolveSpecRoots()
  assert.strictEqual(r1, r2) // same reference = cached
})

test('invalidate clears cache', () => {
  resetMocks()
  mockWsRoot = '/workspace'
  mockConfig.specificationRootPath = 'spec'
  const c = new ConfigLoader()
  c.resolveSpecRoots()
  c.invalidate()
  mockConfig.specificationRootPath = 'other'
  const roots = c.resolveSpecRoots()
  assert.ok(roots[0].endsWith('other'))
})

test('isInsideSpecRoot returns true for file inside spec root', () => {
  resetMocks()
  mockWsRoot = path.resolve('/workspace')
  mockConfig.specificationRootPath = 'spec'
  const c = new ConfigLoader()
  assert.ok(c.isInsideSpecRoot(path.join(path.resolve('/workspace'), 'spec', 'file.md')))
})

test('isInsideSpecRoot returns false for file outside spec root', () => {
  resetMocks()
  mockWsRoot = path.resolve('/workspace')
  mockConfig.specificationRootPath = 'spec'
  const c = new ConfigLoader()
  assert.ok(!c.isInsideSpecRoot(path.join(path.resolve('/workspace'), 'other', 'file.md')))
})

test('findSpecRootFor returns matching root', () => {
  resetMocks()
  mockWsRoot = path.resolve('/workspace')
  mockConfig.specificationRootPath = 'spec'
  const c = new ConfigLoader()
  const root = c.findSpecRootFor(path.join(path.resolve('/workspace'), 'spec', 'sub', 'file.md'))
  assert.ok(root.endsWith('spec'))
})

test('findSpecRootFor returns empty string for no match', () => {
  resetMocks()
  mockWsRoot = path.resolve('/workspace')
  mockConfig.specificationRootPath = 'spec'
  const c = new ConfigLoader()
  assert.strictEqual(c.findSpecRootFor(path.join(path.resolve('/workspace'), 'other', 'file.md')), '')
})

test('getSpecRootForFile returns empty when deriveSectionNumbers is false', () => {
  resetMocks()
  mockWsRoot = path.resolve('/workspace')
  mockConfig.specificationRootPath = 'spec'
  mockConfig.deriveSectionNumbers = false
  const c = new ConfigLoader()
  assert.strictEqual(c.getSpecRootForFile(path.join(path.resolve('/workspace'), 'spec', 'file.md')), '')
})

test('getSpecRootForFile returns root when deriveSectionNumbers is true', () => {
  resetMocks()
  mockWsRoot = path.resolve('/workspace')
  mockConfig.specificationRootPath = 'spec'
  mockConfig.deriveSectionNumbers = true
  const c = new ConfigLoader()
  const root = c.getSpecRootForFile(path.join(path.resolve('/workspace'), 'spec', 'file.md'))
  assert.ok(root.endsWith('spec'))
})

test('isSpecRootSelection returns true when URI matches spec root', () => {
  resetMocks()
  mockWsRoot = path.resolve('/workspace')
  mockConfig.specificationRootPath = 'spec'
  const c = new ConfigLoader()
  const specPath = path.join(path.resolve('/workspace'), 'spec')
  assert.ok(c.isSpecRootSelection([{ fsPath: specPath }]))
})

test('isSpecRootSelection returns false when URI does not match', () => {
  resetMocks()
  mockWsRoot = path.resolve('/workspace')
  mockConfig.specificationRootPath = 'spec'
  const c = new ConfigLoader()
  assert.ok(!c.isSpecRootSelection([{ fsPath: path.join(path.resolve('/workspace'), 'other') }]))
})

test('getExportFolder returns lastExportFolder if it exists', () => {
  resetMocks()
  const c = new ConfigLoader()
  const tmp = os.tmpdir()
  assert.strictEqual(c.getExportFolder(tmp), tmp)
})

test('getExportFolder falls back to wsRoot', () => {
  resetMocks()
  mockWsRoot = os.tmpdir()
  const c = new ConfigLoader()
  assert.strictEqual(c.getExportFolder(null), os.tmpdir())
})

test('loadCss returns default CSS from extension dir', () => {
  resetMocks()
  const c = new ConfigLoader()
  const extensionDir = path.join(__dirname, '../..')
  const css = c.loadCss(extensionDir)
  assert.ok(css.includes('body'))
  assert.ok(css.length > 100)
})

test('loadCss caches result', () => {
  resetMocks()
  const c = new ConfigLoader()
  const extensionDir = path.join(__dirname, '../..')
  const r1 = c.loadCss(extensionDir)
  const r2 = c.loadCss(extensionDir)
  assert.strictEqual(r1, r2)
})

test('loadMermaidConfig returns default config from extension dir', () => {
  resetMocks()
  const c = new ConfigLoader()
  const extensionDir = path.join(__dirname, '../..')
  const config = c.loadMermaidConfig(extensionDir)
  assert.ok(config.startsWith('{'))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
