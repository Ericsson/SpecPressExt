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
    if (e.stack) {
      console.log(`    ${e.stack.split('\n').slice(1, 3).join('\n')}`)
    }
    failed++
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    if (e.stack) {
      console.log(`    ${e.stack.split('\n').slice(1, 3).join('\n')}`)
    }
    failed++
  }
}

// ── Mock vscode module ────────────────────────────────────────

let mockConfig = {}
let mockWsRoot = ''
let mockCommands = {}

const vscodeMock = {
  workspace: {
    getConfiguration: (section) => ({
      get: (key, def) => mockConfig[key] !== undefined ? mockConfig[key] : def
    }),
    get workspaceFolders() {
      return mockWsRoot ? [{ uri: { fsPath: mockWsRoot } }] : null
    },
    onDidChangeConfiguration: (callback) => ({ dispose: () => {} })
  },
  window: {
    showWarningMessage: () => {},
    showErrorMessage: () => {}
  },
  Uri: {
    file: (p) => ({ fsPath: p })
  },
  TreeItem: class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label
      this.collapsibleState = collapsibleState
    }
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  ThemeIcon: class ThemeIcon {
    constructor(id) {
      this.id = id
    }
  },
  EventEmitter: class EventEmitter {
    constructor() {
      this.callbacks = []
    }
    get event() {
      return (callback) => {
        this.callbacks.push(callback)
        return { dispose: () => {} }
      }
    }
    fire(data) {
      this.callbacks.forEach(cb => cb(data))
    }
  },
  commands: {
    executeCommand: (cmd, ...args) => {
      if (mockCommands[cmd]) {
        return mockCommands[cmd](...args)
      }
    }
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
const { ConfigLoader } = require('../../src/vscode/configLoader')
const { BcTreeProvider } = require('../../src/vscode/bandcombinations/bcTreeProvider')

function resetMocks() {
  mockConfig = {}
  mockWsRoot = ''
  mockCommands = {}
}

// ── Helper: Create temp test directory with BC files ──────────

function createTempBcFolder() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'))
  
  // Create some test BC files
  fs.writeFileSync(
    path.join(tmpDir, 'CA_n1A.json'),
    JSON.stringify({ bcId: 'CA_n1A', bcsList: [] })
  )
  fs.writeFileSync(
    path.join(tmpDir, 'CA_n78C.json'),
    JSON.stringify({ bcId: 'CA_n78C', bcsList: [] })
  )
  fs.writeFileSync(
    path.join(tmpDir, 'DC_n1A-n78A.json'),
    JSON.stringify({ bcId: 'DC_n1A-n78A', ulConfigList: [] })
  )
  fs.writeFileSync(
    path.join(tmpDir, 'n1.json'),
    JSON.stringify({ bcId: 'n1', chBwCombSetList: [] })
  )
  
  // Create subfolder with more files
  fs.mkdirSync(path.join(tmpDir, 'subfolder'))
  fs.writeFileSync(
    path.join(tmpDir, 'subfolder', 'CA_n3A-n77A.json'),
    JSON.stringify({ bcId: 'CA_n3A-n77A', bcsList: [] })
  )
  
  return tmpDir
}

function cleanupTempFolder(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── BcTreeProvider tests ──────────────────────────────────────

console.log('BcTreeProvider')

test('constructor initializes with default values', () => {
  resetMocks()
  const config = new ConfigLoader()
  const bcPreviewManager = {}
  const provider = new BcTreeProvider(config, bcPreviewManager)
  
  assert.strictEqual(provider.bcFiles.length, 0)
  assert.strictEqual(provider.filterBcId, '')
  assert.strictEqual(provider.filterBands.length, 0)
  assert.strictEqual(provider.loadCA, true)
  assert.strictEqual(provider.loadDC, false)
  assert.strictEqual(provider.loadBands, true)
})

test('extractBandNumbers extracts band numbers from BC-ID', () => {
  resetMocks()
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  const bands1 = provider.extractBandNumbers('CA_n1A-n78C')
  assert.deepStrictEqual(bands1, ['n1', 'n78'])
  
  const bands2 = provider.extractBandNumbers('DC_n3A-n77A-n79A')
  assert.deepStrictEqual(bands2, ['n3', 'n77', 'n79'])
  
  const bands3 = provider.extractBandNumbers('n1')
  assert.deepStrictEqual(bands3, ['n1'])
})

test('extractCarrierCountHeuristic counts BWC letters', () => {
  resetMocks()
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  assert.strictEqual(provider.extractCarrierCountHeuristic('CA_n1A-n78C'), 2)
  assert.strictEqual(provider.extractCarrierCountHeuristic('CA_n3B'), 1)
  assert.strictEqual(provider.extractCarrierCountHeuristic('CA_n1A-n3(2A)'), 2)
})

test('loadBcFiles scans directory for BC files', () => {
  resetMocks()
  const tmpDir = createTempBcFolder()
  mockWsRoot = tmpDir
  mockConfig.bandCombinationFolder = '.'
  
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  provider.loadBcFiles()
  
  // Should load CA and band files by default (DC disabled)
  assert.ok(provider.bcFiles.length >= 3)
  assert.ok(provider.bcFiles.some(f => f.bcId === 'CA_n1A'))
  assert.ok(provider.bcFiles.some(f => f.bcId === 'n1'))
  assert.ok(!provider.bcFiles.some(f => f.bcId === 'DC_n1A-n78A')) // DC disabled
  
  cleanupTempFolder(tmpDir)
})

test('loadBcFiles respects type filters', () => {
  resetMocks()
  const tmpDir = createTempBcFolder()
  mockWsRoot = tmpDir
  mockConfig.bandCombinationFolder = '.'
  
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  // Disable CA, enable DC
  provider.loadCA = false
  provider.loadDC = true
  provider.loadBands = true
  provider.loadBcFiles()
  
  assert.ok(!provider.bcFiles.some(f => f.bcId === 'CA_n1A'))
  assert.ok(provider.bcFiles.some(f => f.bcId === 'DC_n1A-n78A'))
  assert.ok(provider.bcFiles.some(f => f.bcId === 'n1'))
  
  cleanupTempFolder(tmpDir)
})

test('setTypeFilters updates type filters and refreshes', () => {
  resetMocks()
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  provider.setTypeFilters(false, true, false)
  assert.strictEqual(provider.loadCA, false)
  assert.strictEqual(provider.loadDC, true)
  assert.strictEqual(provider.loadBands, false)
})

testAsync('applyFilters filters by BC ID', async () => {
  resetMocks()
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  const files = [
    { bcId: 'CA_n1A', path: '/test/CA_n1A.json' },
    { bcId: 'CA_n78C', path: '/test/CA_n78C.json' },
    { bcId: 'n1', path: '/test/n1.json' }
  ]
  
  provider.filterBcId = 'ca_n1a'
  const filtered = await provider.applyFilters(files)
  
  assert.strictEqual(filtered.length, 1)
  assert.strictEqual(filtered[0].bcId, 'CA_n1A')
})

testAsync('applyFilters filters by band numbers', async () => {
  resetMocks()
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  const files = [
    { bcId: 'CA_n1A-n78C', path: '/test/CA_n1A-n78C.json' },
    { bcId: 'CA_n3A-n77A', path: '/test/CA_n3A-n77A.json' },
    { bcId: 'CA_n1A', path: '/test/CA_n1A.json' }
  ]
  
  provider.filterBands = ['n1']
  provider.filterBandsMode = 'atLeast'
  const filtered = await provider.applyFilters(files)
  
  assert.strictEqual(filtered.length, 2)
  assert.ok(filtered.some(f => f.bcId === 'CA_n1A-n78C'))
  assert.ok(filtered.some(f => f.bcId === 'CA_n1A'))
})

testAsync('applyFilters "only" mode requires exact band match', async () => {
  resetMocks()
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  const files = [
    { bcId: 'CA_n1A-n78C', path: '/test/CA_n1A-n78C.json' },
    { bcId: 'CA_n1A', path: '/test/CA_n1A.json' }
  ]
  
  provider.filterBands = ['n1']
  provider.filterBandsMode = 'only'
  const filtered = await provider.applyFilters(files)
  
  assert.strictEqual(filtered.length, 1)
  assert.strictEqual(filtered[0].bcId, 'CA_n1A')
})

test('getAllBands returns unique band list', () => {
  resetMocks()
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  provider.bcFiles = [
    { bcId: 'CA_n1A-n78C', path: '/test1' },
    { bcId: 'CA_n3A-n77A', path: '/test2' },
    { bcId: 'CA_n1A', path: '/test3' }
  ]
  
  const bands = provider.getAllBands()
  assert.deepStrictEqual(bands.sort(), ['n1', 'n3', 'n77', 'n78'])
})

testAsync('getChildren shows config hint when not configured', async () => {
  resetMocks()
  mockConfig.bandCombinationFolder = ''
  
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  const children = await provider.getChildren()
  assert.strictEqual(children.length, 1)
  assert.strictEqual(children[0].label, 'Configuration Required')
  assert.strictEqual(children[0].itemType, 'hint')
})

testAsync('getChildren shows empty state when no files found', async () => {
  resetMocks()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-empty-'))
  mockWsRoot = tmpDir
  mockConfig.bandCombinationFolder = '.'
  
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  const children = await provider.getChildren()
  assert.strictEqual(children.length, 1)
  assert.strictEqual(children[0].label, 'No Band Combinations Found')
  assert.strictEqual(children[0].itemType, 'empty')
  
  cleanupTempFolder(tmpDir)
})

testAsync('getChildren returns BC items when files exist', async () => {
  resetMocks()
  const tmpDir = createTempBcFolder()
  mockWsRoot = tmpDir
  mockConfig.bandCombinationFolder = '.'
  
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  const children = await provider.getChildren()
  assert.ok(children.length >= 3)
  assert.ok(children.every(c => c.itemType === 'bc'))
  assert.ok(children.some(c => c.label === 'CA_n1A'))
  
  cleanupTempFolder(tmpDir)
})

test('getFilteredFiles returns current filtered list', () => {
  resetMocks()
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  provider.currentFilteredFiles = [
    { bcId: 'CA_n1A', path: '/test' }
  ]
  
  const filtered = provider.getFilteredFiles()
  assert.strictEqual(filtered.length, 1)
  assert.strictEqual(filtered[0].bcId, 'CA_n1A')
})

test('dispose cleans up config change listener', () => {
  resetMocks()
  const config = new ConfigLoader()
  const provider = new BcTreeProvider(config, {})
  
  let disposed = false
  provider.configChangeListener = { dispose: () => { disposed = true } }
  
  provider.dispose()
  assert.strictEqual(disposed, true)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
