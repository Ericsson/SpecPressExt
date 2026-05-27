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
    if (e.stack) console.log(`    ${e.stack.split('\n')[1]}`)
    failed++
  }
}

// ── Mock vscode module ────────────────────────────────────────

let mockConfig = {}
let mockWarnings = []
let mockErrors = []
let mockInfos = []

const vscodeMock = {
  workspace: {
    getConfiguration: (section) => ({
      get: (key, def) => mockConfig[key] !== undefined ? mockConfig[key] : def
    }),
    workspaceFolders: null
  },
  window: {
    showWarningMessage: async (msg) => { mockWarnings.push(msg); return null },
    showErrorMessage: (msg) => mockErrors.push(msg),
    showInformationMessage: async (msg) => { mockInfos.push(msg); return null }
  },
  Uri: {
    file: (p) => ({ fsPath: p })
  },
  Position: class {
    constructor(line, character) { this.line = line; this.character = character }
  },
  Range: class {
    constructor(startLine, startChar, endLine, endChar) {
      this.start = { line: startLine, character: startChar }
      this.end = { line: endLine, character: endChar }
    }
  },
  EventEmitter: class {
    constructor() { this._listeners = [] }
    get event() { return (fn) => { this._listeners.push(fn); return { dispose: () => {} } } }
    fire(data) { this._listeners.forEach(fn => fn(data)) }
    dispose() { this._listeners = [] }
  }
}

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode'
  return origResolve.call(this, request, ...args)
}
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeMock }

const { CommentManager } = require('../../src/vscode/commenting/commentManager')
const { ConfigLoader } = require('../../src/vscode/configLoader')

function resetMocks() {
  mockConfig = {}
  mockWarnings = []
  mockErrors = []
  mockInfos = []
}

function createTempDir() {
  const tmpDir = path.join(os.tmpdir(), `specpress_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  return tmpDir
}

function cleanupDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── CommentManager tests ──────────────────────────────────────

async function run() {
  console.log('CommentManager - Basic Operations')

  await test('generates unique comment IDs with author prefix', async () => {
    resetMocks()
    mockConfig.userId = 'testuser'
    mockConfig.userName = 'Test User'
    const config = new ConfigLoader()
    const mgr = new CommentManager(config)
    
    const id1 = mgr.generateCommentId('testuser')
    const id2 = mgr.generateCommentId('testuser')
    
    assert.ok(id1.startsWith('testuser_'))
    assert.ok(id2.startsWith('testuser_'))
    assert.notStrictEqual(id1, id2)
    assert.ok(id1.endsWith('.json'))
  })

  await test('normalizes file URIs to forward slashes', async () => {
    resetMocks()
    mockConfig.userId = 'testuser'
    const config = new ConfigLoader()
    const mgr = new CommentManager(config)
    
    const normalized = mgr.normalizeUri('c:\\path\\to\\file.md')
    assert.strictEqual(normalized, 'c:/path/to/file.md')
  })

  await test('creates comment with all required fields', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const comment = await mgr.createComment(
        'file.md',
        10,
        5,
        'This is the line content',
        'My comment text',
        specRoot
      )
      
      assert.strictEqual(comment.authorId, 'testuser')
      assert.strictEqual(comment.authorName, 'Test User')
      assert.strictEqual(comment.fileUri, 'file.md')
      assert.strictEqual(comment.lineNumber, 10)
      assert.strictEqual(comment.columnNumber, 5)
      assert.strictEqual(comment.lineSnippet, 'This is the line content')
      assert.strictEqual(comment.commentText, 'My comment text')
      assert.strictEqual(comment.resolved, false)
      assert.strictEqual(comment.replyTo, null)
      assert.ok(comment.commentId)
      assert.ok(comment.createdAt)
      assert.ok(comment.updatedAt)
      
      // Verify file was created
      const commentPath = path.join(mgr.getCommentFolder(specRoot), comment.commentId)
      assert.ok(fs.existsSync(commentPath))
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('creates reply with replyTo field set and no lineSnippet', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const parent = await mgr.createComment('file.md', 10, 5, 'snippet text', 'Parent comment', specRoot)
      const reply = await mgr.createReply(parent.commentId, 'Reply text', specRoot)
      
      assert.strictEqual(reply.replyTo, parent.commentId)
      assert.strictEqual(reply.commentText, 'Reply text')
      assert.strictEqual(reply.fileUri, parent.fileUri)
      assert.strictEqual(reply.lineNumber, parent.lineNumber)
      assert.strictEqual(reply.columnNumber, parent.columnNumber)
      assert.strictEqual(reply.lineSnippet, null, 'reply should not have lineSnippet')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('throws error when userId or userName not configured', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = ''
      mockConfig.userName = ''
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      let threw = false
      try {
        await mgr.createComment('file.md', 10, 5, 'line', 'text', specRoot)
      } catch (e) {
        threw = true
        assert.ok(e.message.includes('Configure'))
      }
      assert.ok(threw, 'Should throw error')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('updates comment text and timestamp', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const comment = await mgr.createComment('file.md', 10, 5, 'line', 'Original text', specRoot)
      const originalUpdatedAt = comment.updatedAt
      
      await new Promise(resolve => setTimeout(resolve, 10))
      await mgr.updateComment(comment.commentId, specRoot, 'Updated text')
      
      const updated = mgr.getAllComments(specRoot).find(c => c.commentId === comment.commentId)
      assert.strictEqual(updated.commentText, 'Updated text')
      assert.notStrictEqual(updated.updatedAt, originalUpdatedAt)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('resolves comment with resolvedBy and resolvedInCommit', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const comment = await mgr.createComment('file.md', 10, 5, 'line', 'text', specRoot)
      await mgr.resolveComment(comment.commentId, specRoot, true, 'Test User')
      
      const resolved = mgr.getAllComments(specRoot).find(c => c.commentId === comment.commentId)
      assert.strictEqual(resolved.resolved, true)
      assert.strictEqual(resolved.resolvedBy, 'Test User')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('unresolves comment and clears resolvedBy', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const comment = await mgr.createComment('file.md', 10, 5, 'line', 'text', specRoot)
      await mgr.resolveComment(comment.commentId, specRoot, true, 'Test User')
      await mgr.resolveComment(comment.commentId, specRoot, false, null)
      
      const unresolved = mgr.getAllComments(specRoot).find(c => c.commentId === comment.commentId)
      assert.strictEqual(unresolved.resolved, false)
      assert.strictEqual(unresolved.resolvedBy, null)
      assert.strictEqual(unresolved.resolvedInCommit, null)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('finds comments for specific file', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      await mgr.createComment('file1.md', 10, 5, 'line', 'comment 1', specRoot)
      await mgr.createComment('file2.md', 20, 10, 'line', 'comment 2', specRoot)
      await mgr.createComment('file1.md', 30, 15, 'line', 'comment 3', specRoot)
      
      const file1Comments = await mgr.findCommentsForFile('file1.md', specRoot)
      assert.strictEqual(file1Comments.length, 2)
      assert.ok(file1Comments.every(c => c.fileUri === 'file1.md'))
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('getAllComments returns all comments', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      await mgr.createComment('file1.md', 10, 5, 'line', 'comment 1', specRoot)
      await mgr.createComment('file2.md', 20, 10, 'line', 'comment 2', specRoot)
      
      const all = mgr.getAllComments(specRoot)
      assert.strictEqual(all.length, 2)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('getAllComments returns empty array for non-existent folder', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const all = mgr.getAllComments(specRoot)
      assert.strictEqual(all.length, 0)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  // ── Cache tests ───────────────────────────────────────────────

  console.log('\nCommentManager - Cache Performance')

  await test('caches getAllComments results', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      await mgr.createComment('file.md', 10, 5, 'line', 'comment', specRoot)
      
      const result1 = mgr.getAllComments(specRoot)
      const result2 = mgr.getAllComments(specRoot)
      
      // Same reference = cached
      assert.strictEqual(result1, result2)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('invalidateCache clears cache for specific spec root', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      await mgr.createComment('file.md', 10, 5, 'line', 'comment', specRoot)
      
      const result1 = mgr.getAllComments(specRoot)
      mgr.invalidateCache(specRoot)
      const result2 = mgr.getAllComments(specRoot)
      
      // Different reference = cache was cleared
      assert.notStrictEqual(result1, result2)
      assert.deepStrictEqual(result1, result2) // But same content
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('cache invalidated after createComment', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const before = mgr.getAllComments(specRoot)
      await mgr.createComment('file.md', 10, 5, 'line', 'new comment', specRoot)
      const after = mgr.getAllComments(specRoot)
      
      assert.strictEqual(before.length, 0)
      assert.strictEqual(after.length, 1)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('cache invalidated after updateComment', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const comment = await mgr.createComment('file.md', 10, 5, 'line', 'original', specRoot)
      const before = mgr.getAllComments(specRoot)[0]
      
      await mgr.updateComment(comment.commentId, specRoot, 'updated')
      const after = mgr.getAllComments(specRoot)[0]
      
      assert.strictEqual(before.commentText, 'original')
      assert.strictEqual(after.commentText, 'updated')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('cache invalidated after resolveComment', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const comment = await mgr.createComment('file.md', 10, 5, 'line', 'text', specRoot)
      const before = mgr.getAllComments(specRoot)[0]
      
      await mgr.resolveComment(comment.commentId, specRoot, true, 'User')
      const after = mgr.getAllComments(specRoot)[0]
      
      assert.strictEqual(before.resolved, false)
      assert.strictEqual(after.resolved, true)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('cache expires after timeout', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      // Override cache timeout to 50ms for testing
      mgr._cacheTimeout = 50
      
      await mgr.createComment('file.md', 10, 5, 'line', 'comment', specRoot)
      
      const result1 = mgr.getAllComments(specRoot)
      await new Promise(resolve => setTimeout(resolve, 60))
      const result2 = mgr.getAllComments(specRoot)
      
      // Different reference = cache expired and was re-read
      assert.notStrictEqual(result1, result2)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('clearCache clears all caches', async () => {
    const tmpDir = createTempDir()
    const specRoot1 = path.join(tmpDir, 'spec1')
    const specRoot2 = path.join(tmpDir, 'spec2')
    fs.mkdirSync(specRoot1, { recursive: true })
    fs.mkdirSync(specRoot2, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      await mgr.createComment('file.md', 10, 5, 'line', 'comment1', specRoot1)
      await mgr.createComment('file.md', 10, 5, 'line', 'comment2', specRoot2)
      
      const r1_before = mgr.getAllComments(specRoot1)
      const r2_before = mgr.getAllComments(specRoot2)
      
      mgr.clearCache()
      
      const r1_after = mgr.getAllComments(specRoot1)
      const r2_after = mgr.getAllComments(specRoot2)
      
      assert.notStrictEqual(r1_before, r1_after)
      assert.notStrictEqual(r2_before, r2_after)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  // ── Nested replies tests ──────────────────────────────────────

  console.log('\nCommentManager - Nested Replies')

  await test('creates nested reply chain', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      const parent = await mgr.createComment('file.md', 10, 5, 'line snippet', 'Parent', specRoot)
      const reply1 = await mgr.createReply(parent.commentId, 'Reply 1', specRoot)
      const reply2 = await mgr.createReply(reply1.commentId, 'Reply to reply', specRoot)
      
      const all = mgr.getAllComments(specRoot)
      assert.strictEqual(all.length, 3)
      
      const r1 = all.find(c => c.commentId === reply1.commentId)
      const r2 = all.find(c => c.commentId === reply2.commentId)
      
      assert.strictEqual(r1.replyTo, parent.commentId)
      assert.strictEqual(r2.replyTo, reply1.commentId)
      assert.strictEqual(r1.lineSnippet, null, 'reply should not have lineSnippet')
      assert.strictEqual(r2.lineSnippet, null, 'nested reply should not have lineSnippet')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  // ── Error handling tests ──────────────────────────────────────

  console.log('\nCommentManager - Error Handling')

  await test('updateComment throws for non-existent comment', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      let threw = false
      try {
        await mgr.updateComment('nonexistent.json', specRoot, 'text')
      } catch (e) {
        threw = true
        assert.ok(e.message.includes('not found'))
      }
      assert.ok(threw)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('resolveComment throws for non-existent comment', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      let threw = false
      try {
        await mgr.resolveComment('nonexistent.json', specRoot, true, 'User')
      } catch (e) {
        threw = true
        assert.ok(e.message.includes('not found'))
      }
      assert.ok(threw)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('skips invalid JSON files in getAllComments', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    const commentFolder = path.join(path.dirname(specRoot), 'comments')
    fs.mkdirSync(specRoot, { recursive: true })
    fs.mkdirSync(commentFolder, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      await mgr.createComment('file.md', 10, 5, 'line', 'valid', specRoot)
      
      // Create invalid JSON file
      fs.writeFileSync(path.join(commentFolder, 'invalid.json'), 'not json')
      
      const all = mgr.getAllComments(specRoot)
      assert.strictEqual(all.length, 1) // Only valid comment
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('sanitizes reply with lineSnippet loaded from disk', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    const commentFolder = path.join(path.dirname(specRoot), 'comments')
    fs.mkdirSync(specRoot, { recursive: true })
    fs.mkdirSync(commentFolder, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      // Simulate a hand-edited JSON file that has both replyTo and lineSnippet
      const malformed = {
        commentId: 'testuser_abc123.json',
        authorId: 'testuser',
        authorName: 'Test User',
        fileUri: 'file.md',
        lineNumber: 10,
        columnNumber: 5,
        lineSnippet: 'should be stripped',
        commentText: 'A reply',
        replyTo: 'parent_def456.json',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resolved: false
      }
      fs.writeFileSync(path.join(commentFolder, 'testuser_abc123.json'), JSON.stringify(malformed))
      
      const all = mgr.getAllComments(specRoot)
      const loaded = all.find(c => c.commentId === 'testuser_abc123.json')
      assert.ok(loaded, 'comment should be loaded')
      assert.strictEqual(loaded.replyTo, 'parent_def456.json')
      assert.strictEqual(loaded.lineSnippet, null, 'lineSnippet should be stripped from reply on load')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('createReply throws for non-existent parent', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      let threw = false
      try {
        await mgr.createReply('nonexistent.json', 'Reply text', specRoot)
      } catch (e) {
        threw = true
        assert.ok(e.message.includes('Parent comment not found'))
      }
      assert.ok(threw)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('createComment throws when lineSnippet is missing', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })
    
    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)
      
      let threw = false
      try {
        await mgr.createComment('file.md', 10, 5, null, 'text', specRoot)
      } catch (e) {
        threw = true
        assert.ok(e.message.includes('must have a lineSnippet'))
      }
      assert.ok(threw)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  // ── Status computation tests ──────────────────────────────────

  console.log('\nCommentManager - Status Computation')

  await test('validateAndUpdateStatuses stamps _statusKey on all comments', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      await mgr.createComment('file.md', 0, 5, 'hello world here now', 'comment 1', specRoot)
      await mgr.createComment('other.md', 3, 0, 'other line', 'comment 2', specRoot)

      // Mock document where snippet matches at original position
      const text = 'hello world here now\nline2\nline3\nline4\nline5'
      const mockDoc = {
        lineCount: 5,
        getText: (range) => {
          if (!range) return text
          const start = range.start.line * 21 + range.start.character
          const end = range.end.line * 21 + range.end.character
          return text.substring(start, end)
        },
        lineAt: (n) => ({ text: text.split('\n')[n] || '' }),
        positionAt: (offset) => ({ line: Math.floor(offset / 21), character: offset % 21 }),
        offsetAt: (pos) => pos.line * 21 + pos.character
      }

      mgr.validateAndUpdateStatuses(specRoot, 'file.md', mockDoc)

      const all = mgr.getAllComments(specRoot)
      const c1 = all.find(c => c.fileUri === 'file.md')
      const c2 = all.find(c => c.fileUri === 'other.md')

      assert.ok(c1._statusKey !== null, 'file.md comment should have _statusKey')
      assert.ok(c2._statusKey !== null, 'other.md comment should have _statusKey')
      // c2 was not validated (different file) so hasMoved=false, unresolved
      assert.strictEqual(c2._statusKey, 'unresolved')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('validateAndUpdateStatuses detects moved comment', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      // Comment at line 0 with snippet 'original text'
      await mgr.createComment('file.md', 0, 0, 'original text', 'my comment', specRoot)

      // Document where 'original text' moved to line 2
      const mockDoc = {
        lineCount: 5,
        getText: () => 'new line\nanother\noriginal text\nline4\nline5',
        lineAt: (n) => ({ text: ['new line', 'another', 'original text', 'line4', 'line5'][n] || '' }),
        positionAt: (offset) => ({ line: 0, character: offset }),
        offsetAt: (pos) => pos.character
      }

      mgr.validateAndUpdateStatuses(specRoot, 'file.md', mockDoc)

      const all = mgr.getAllComments(specRoot)
      const c = all.find(c => c.fileUri === 'file.md')
      assert.strictEqual(c._statusKey, 'moved')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('replies do not have resolved status', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      const parent = await mgr.createComment('file.md', 0, 0, 'snippet', 'parent', specRoot)
      const reply = await mgr.createReply(parent.commentId, 'reply text', specRoot)

      // Parent should have resolved field
      assert.strictEqual(parent.resolved, false)
      
      // Reply should not have resolved field
      assert.strictEqual(reply.resolved, undefined)
      
      // Use _recomputeStatuses which doesn't need a document
      mgr._recomputeStatuses(specRoot)

      const all = mgr.getAllComments(specRoot)
      const p = all.find(c => c.commentId === parent.commentId)
      const r = all.find(c => c.commentId === reply.commentId)
      
      // Parent has status
      assert.strictEqual(p._statusKey, 'unresolved')
      
      // Reply has no status
      assert.strictEqual(r._statusKey, null)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('onDidChange fires after createComment', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      let fired = 0
      mgr.onDidChange(() => fired++)

      await mgr.createComment('file.md', 0, 0, 'line', 'text', specRoot)
      assert.strictEqual(fired, 1)

      await mgr.updateComment(
        mgr.getAllComments(specRoot)[0].commentId, specRoot, 'new'
      )
      assert.strictEqual(fired, 2)

      await mgr.resolveComment(
        mgr.getAllComments(specRoot)[0].commentId, specRoot, true, 'U'
      )
      assert.strictEqual(fired, 3)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('_recomputeStatuses sets status without validation', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      const parent = await mgr.createComment('file.md', 0, 0, 'line', 'parent', specRoot)
      await mgr.resolveComment(parent.commentId, specRoot, true, 'User')

      mgr._recomputeStatuses(specRoot)

      const all = mgr.getAllComments(specRoot)
      const p = all.find(c => c.commentId === parent.commentId)
      assert.strictEqual(p._statusKey, 'resolved')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('findCommentsForFile returns same cached objects as getAllComments', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      await mgr.createComment('file.md', 0, 0, 'line', 'text', specRoot)

      const all = mgr.getAllComments(specRoot)
      const forFile = await mgr.findCommentsForFile('file.md', specRoot)

      // Same object reference = shared cache
      assert.strictEqual(all[0], forFile[0])
    } finally {
      cleanupDir(tmpDir)
    }
  })

  // ── Auto-update tests ─────────────────────────────────────────

  console.log('\nCommentManager - Auto-Update on Save')

  await test('autoUpdateOnSave updates comment when moved within 10 lines', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      // Original document where unique text is at line 5
      const originalLines = [
        'line 0 content',
        'line 1 content',
        'line 2 content',
        'line 3 content',
        'line 4 content',
        'some text hello world unique snippet text here and more',  // line 5
        'line 6 content',
        'line 7 content',
        'line 8 content',
        'line 9 content'
      ]
      const originalFullText = originalLines.join('\n')
      
      // Create comment at line 5, column 10 with proper snippet extraction
      const lineNumber = 5
      const columnNumber = 10
      const mockDocForCreation = {
        getText: (range) => {
          if (!range) return originalFullText
          const startLine = range.start.line
          const endLine = range.end.line
          const startChar = range.start.character
          const endChar = range.end.character
          
          if (startLine >= originalLines.length || endLine >= originalLines.length) return ''
          
          if (startLine === endLine) {
            const line = originalLines[startLine] || ''
            return line.substring(startChar, endChar)
          }
          
          const startLineText = originalLines[startLine] || ''
          let result = startLineText.substring(startChar)
          for (let i = startLine + 1; i < endLine; i++) {
            result += '\n' + (originalLines[i] || '')
          }
          if (endLine < originalLines.length) {
            const endLineText = originalLines[endLine] || ''
            result += '\n' + endLineText.substring(0, endChar)
          }
          return result
        },
        positionAt: (offset) => {
          let currentOffset = 0
          for (let i = 0; i < originalLines.length; i++) {
            const lineLength = originalLines[i].length + 1
            if (currentOffset + lineLength > offset) {
              return new vscodeMock.Position(i, offset - currentOffset)
            }
            currentOffset += lineLength
          }
          return new vscodeMock.Position(originalLines.length - 1, originalLines[originalLines.length - 1].length)
        },
        offsetAt: (pos) => {
          let offset = 0
          for (let i = 0; i < pos.line && i < originalLines.length; i++) {
            offset += originalLines[i].length + 1
          }
          return offset + pos.character
        }
      }
      
      // Extract snippet: 20 chars BEFORE cursor
      const cursorPos = new vscodeMock.Position(lineNumber, columnNumber)
      const cursorOffset = mockDocForCreation.offsetAt(cursorPos)
      const startOffset = Math.max(0, cursorOffset - 20)
      const startPos = mockDocForCreation.positionAt(startOffset)
      const snippet = mockDocForCreation.getText(new vscodeMock.Range(startPos.line, startPos.character, cursorPos.line, cursorPos.character))

      await mgr.createComment('file.md', lineNumber, columnNumber, snippet, 'my comment', specRoot)

      // Now create the NEW document where 3 lines were inserted, moving content down to line 8
      const newLines = [
        'line 0 content',
        'line 1 content',
        'line 2 content',
        'INSERTED LINE A',  // new
        'INSERTED LINE B',  // new
        'INSERTED LINE C',  // new
        'line 3 content',
        'line 4 content',
        'some text hello world unique snippet text here and more',  // now at line 8
        'line 6 content',
        'line 7 content',
        'line 8 content',
        'line 9 content'
      ]
      const newFullText = newLines.join('\n')
      const mockDoc = {
        uri: { fsPath: path.join(specRoot, 'file.md') },
        lineCount: newLines.length,
        getText: (range) => {
          if (!range) return newFullText
          const startLine = range.start.line
          const endLine = range.end.line
          const startChar = range.start.character
          const endChar = range.end.character
          
          if (startLine >= newLines.length || endLine >= newLines.length) return ''
          
          if (startLine === endLine) {
            const line = newLines[startLine] || ''
            return line.substring(startChar, endChar)
          }
          
          const startLineText = newLines[startLine] || ''
          let result = startLineText.substring(startChar)
          for (let i = startLine + 1; i < endLine; i++) {
            result += '\n' + (newLines[i] || '')
          }
          if (endLine < newLines.length) {
            const endLineText = newLines[endLine] || ''
            result += '\n' + endLineText.substring(0, endChar)
          }
          return result
        },
        lineAt: (n) => ({ text: newLines[n] || '' }),
        positionAt: (offset) => {
          let currentOffset = 0
          for (let i = 0; i < newLines.length; i++) {
            const lineLength = newLines[i].length + 1
            if (currentOffset + lineLength > offset) {
              return new vscodeMock.Position(i, offset - currentOffset)
            }
            currentOffset += lineLength
          }
          return new vscodeMock.Position(newLines.length - 1, newLines[newLines.length - 1].length)
        },
        offsetAt: (pos) => {
          let offset = 0
          for (let i = 0; i < pos.line && i < newLines.length; i++) {
            offset += newLines[i].length + 1
          }
          return offset + pos.character
        }
      }

      const result = await mgr.autoUpdateOnSave(mockDoc, specRoot)

      assert.strictEqual(result.count, 1, 'should auto-update one comment')
      assert.strictEqual(result.details.length, 1)

      // Verify comment was updated to line 8
      const updated = mgr.getAllComments(specRoot)[0]
      assert.strictEqual(updated.lineNumber, 8, 'comment should be at line 8')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('autoUpdateOnSave does not update when moved more than 10 lines', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      // Create comment at line 5
      await mgr.createComment('file.md', 5, 0, 'unique snippet text', 'my comment', specRoot)

      // Mock document where snippet moved to line 20 (more than 10 lines)
      const lines = Array(25).fill(0).map((_, i) => i === 20 ? 'unique snippet text' : `line ${i}`)
      const mockDoc = {
        uri: { fsPath: path.join(specRoot, 'file.md') },
        lineCount: lines.length,
        getText: (range) => {
          if (!range) return lines.join('\n')
          return lines.join('\n')
        },
        lineAt: (n) => ({ text: lines[n] || '' }),
        positionAt: (offset) => new vscodeMock.Position(0, offset),
        offsetAt: (pos) => pos.character
      }

      const result = await mgr.autoUpdateOnSave(mockDoc, specRoot)

      assert.strictEqual(result.count, 0, 'should not auto-update when moved > 10 lines')

      // Verify comment was NOT updated
      const unchanged = mgr.getAllComments(specRoot)[0]
      assert.strictEqual(unchanged.lineNumber, 5)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('autoUpdateOnSave does not update when snippet appears multiple times', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      // Create comment at line 5
      await mgr.createComment('file.md', 5, 0, 'duplicate text', 'my comment', specRoot)

      // Mock document where snippet appears twice
      const lines = [
        'line 0', 'duplicate text', 'line 2', 'line 3', 'line 4',
        'line 5', 'line 6', 'duplicate text', 'line 8', 'line 9'
      ]
      const mockDoc = {
        uri: { fsPath: path.join(specRoot, 'file.md') },
        lineCount: lines.length,
        getText: (range) => {
          if (!range) return lines.join('\n')
          return lines.join('\n')
        },
        lineAt: (n) => ({ text: lines[n] || '' }),
        positionAt: (offset) => new vscodeMock.Position(0, offset),
        offsetAt: (pos) => pos.character
      }

      const result = await mgr.autoUpdateOnSave(mockDoc, specRoot)

      assert.strictEqual(result.count, 0, 'should not auto-update when ambiguous')

      // Verify comment was NOT updated
      const unchanged = mgr.getAllComments(specRoot)[0]
      assert.strictEqual(unchanged.lineNumber, 5)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('autoUpdateOnSave does not update when snippet not found', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      // Create comment at line 5
      await mgr.createComment('file.md', 5, 0, 'deleted text', 'my comment', specRoot)

      // Mock document where snippet was deleted
      const lines = Array(10).fill(0).map((_, i) => `line ${i}`)
      const mockDoc = {
        uri: { fsPath: path.join(specRoot, 'file.md') },
        lineCount: lines.length,
        getText: (range) => {
          if (!range) return lines.join('\n')
          return lines.join('\n')
        },
        lineAt: (n) => ({ text: lines[n] || '' }),
        positionAt: (offset) => new vscodeMock.Position(0, offset),
        offsetAt: (pos) => pos.character
      }

      const result = await mgr.autoUpdateOnSave(mockDoc, specRoot)

      assert.strictEqual(result.count, 0, 'should not auto-update when not found')

      // Verify comment was NOT updated
      const unchanged = mgr.getAllComments(specRoot)[0]
      assert.strictEqual(unchanged.lineNumber, 5)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('autoUpdateOnSave skips reply comments', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      const parent = await mgr.createComment('file.md', 5, 0, 'parent text', 'parent', specRoot)
      await mgr.createReply(parent.commentId, 'reply text', specRoot)

      const mockDoc = {
        uri: { fsPath: path.join(specRoot, 'file.md') },
        lineCount: 10,
        getText: () => 'some text',
        lineAt: (n) => ({ text: 'some text' }),
        positionAt: (offset) => new vscodeMock.Position(0, offset),
        offsetAt: (pos) => pos.character
      }

      const result = await mgr.autoUpdateOnSave(mockDoc, specRoot)

      // Should only consider parent comment, not reply
      const all = mgr.getAllComments(specRoot)
      assert.strictEqual(all.length, 2)
      assert.strictEqual(all.filter(c => !c.replyTo).length, 1)
    } finally {
      cleanupDir(tmpDir)
    }
  })

  await test('autoUpdateOnSave fires onDidChange when updates occur', async () => {
    const tmpDir = createTempDir()
    const specRoot = path.join(tmpDir, 'spec')
    fs.mkdirSync(specRoot, { recursive: true })

    try {
      resetMocks()
      mockConfig.userId = 'testuser'
      mockConfig.userName = 'Test User'
      mockConfig.commentFolder = 'comments'
      const config = new ConfigLoader()
      const mgr = new CommentManager(config)

      // Original document where unique text is at line 5
      const originalLines = [
        'line 0 content',
        'line 1 content',
        'line 2 content',
        'line 3 content',
        'line 4 content',
        'some text hello world unique snippet text here and more',  // line 5
        'line 6 content',
        'line 7 content',
        'line 8 content',
        'line 9 content'
      ]
      const originalFullText = originalLines.join('\n')
      
      // Create comment at line 5, column 10 with proper snippet extraction
      const lineNumber = 5
      const columnNumber = 10
      const mockDocForCreation = {
        getText: (range) => {
          if (!range) return originalFullText
          const startLine = range.start.line
          const endLine = range.end.line
          const startChar = range.start.character
          const endChar = range.end.character
          
          if (startLine >= originalLines.length || endLine >= originalLines.length) return ''
          
          if (startLine === endLine) {
            const line = originalLines[startLine] || ''
            return line.substring(startChar, endChar)
          }
          
          const startLineText = originalLines[startLine] || ''
          let result = startLineText.substring(startChar)
          for (let i = startLine + 1; i < endLine; i++) {
            result += '\n' + (originalLines[i] || '')
          }
          if (endLine < originalLines.length) {
            const endLineText = originalLines[endLine] || ''
            result += '\n' + endLineText.substring(0, endChar)
          }
          return result
        },
        positionAt: (offset) => {
          let currentOffset = 0
          for (let i = 0; i < originalLines.length; i++) {
            const lineLength = originalLines[i].length + 1
            if (currentOffset + lineLength > offset) {
              return new vscodeMock.Position(i, offset - currentOffset)
            }
            currentOffset += lineLength
          }
          return new vscodeMock.Position(originalLines.length - 1, originalLines[originalLines.length - 1].length)
        },
        offsetAt: (pos) => {
          let offset = 0
          for (let i = 0; i < pos.line && i < originalLines.length; i++) {
            offset += originalLines[i].length + 1
          }
          return offset + pos.character
        }
      }
      
      // Extract snippet: 20 chars BEFORE cursor
      const cursorPos = new vscodeMock.Position(lineNumber, columnNumber)
      const cursorOffset = mockDocForCreation.offsetAt(cursorPos)
      const startOffset = Math.max(0, cursorOffset - 20)
      const startPos = mockDocForCreation.positionAt(startOffset)
      const snippet = mockDocForCreation.getText(new vscodeMock.Range(startPos.line, startPos.character, cursorPos.line, cursorPos.character))

      await mgr.createComment('file.md', lineNumber, columnNumber, snippet, 'my comment', specRoot)
      
      let fired = 0
      mgr.onDidChange(() => fired++)

      // New document where 3 lines were inserted, moving content down to line 8
      const newLines = [
        'line 0 content',
        'line 1 content',
        'line 2 content',
        'INSERTED LINE A',
        'INSERTED LINE B',
        'INSERTED LINE C',
        'line 3 content',
        'line 4 content',
        'some text hello world unique snippet text here and more',  // now at line 8
        'line 6 content',
        'line 7 content',
        'line 8 content',
        'line 9 content'
      ]
      const newFullText = newLines.join('\n')
      const mockDoc = {
        uri: { fsPath: path.join(specRoot, 'file.md') },
        lineCount: newLines.length,
        getText: (range) => {
          if (!range) return newFullText
          const startLine = range.start.line
          const endLine = range.end.line
          const startChar = range.start.character
          const endChar = range.end.character
          
          if (startLine >= newLines.length || endLine >= newLines.length) return ''
          
          if (startLine === endLine) {
            const line = newLines[startLine] || ''
            return line.substring(startChar, endChar)
          }
          
          const startLineText = newLines[startLine] || ''
          let result = startLineText.substring(startChar)
          for (let i = startLine + 1; i < endLine; i++) {
            result += '\n' + (newLines[i] || '')
          }
          if (endLine < newLines.length) {
            const endLineText = newLines[endLine] || ''
            result += '\n' + endLineText.substring(0, endChar)
          }
          return result
        },
        lineAt: (n) => ({ text: newLines[n] || '' }),
        positionAt: (offset) => {
          let currentOffset = 0
          for (let i = 0; i < newLines.length; i++) {
            const lineLength = newLines[i].length + 1
            if (currentOffset + lineLength > offset) {
              return new vscodeMock.Position(i, offset - currentOffset)
            }
            currentOffset += lineLength
          }
          return new vscodeMock.Position(newLines.length - 1, newLines[newLines.length - 1].length)
        },
        offsetAt: (pos) => {
          let offset = 0
          for (let i = 0; i < pos.line; i++) {
            offset += newLines[i].length + 1
          }
          return offset + pos.character
        }
      }

      await mgr.autoUpdateOnSave(mockDoc, specRoot)

      assert.strictEqual(fired, 1, 'onDidChange should fire after auto-update')
    } finally {
      cleanupDir(tmpDir)
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
