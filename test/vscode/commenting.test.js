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

  await test('creates reply with replyTo field set', async () => {
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
      
      const parent = await mgr.createComment('file.md', 10, 5, 'line', 'Parent comment', specRoot)
      const reply = await mgr.createReply(parent.commentId, 'file.md', 10, 5, 'line', 'Reply text', specRoot)
      
      assert.strictEqual(reply.replyTo, parent.commentId)
      assert.strictEqual(reply.commentText, 'Reply text')
      assert.strictEqual(reply.fileUri, parent.fileUri)
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
      
      const parent = await mgr.createComment('file.md', 10, 5, 'line', 'Parent', specRoot)
      const reply1 = await mgr.createReply(parent.commentId, 'file.md', 10, 5, 'line', 'Reply 1', specRoot)
      const reply2 = await mgr.createReply(reply1.commentId, 'file.md', 10, 5, 'line', 'Reply to reply', specRoot)
      
      const all = mgr.getAllComments(specRoot)
      assert.strictEqual(all.length, 3)
      
      const r1 = all.find(c => c.commentId === reply1.commentId)
      const r2 = all.find(c => c.commentId === reply2.commentId)
      
      assert.strictEqual(r1.replyTo, parent.commentId)
      assert.strictEqual(r2.replyTo, reply1.commentId)
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

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

run()
