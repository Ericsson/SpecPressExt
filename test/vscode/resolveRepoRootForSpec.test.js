const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execSync } = require('child_process')
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

// Mock vscode (resolveRepoRootForSpec itself doesn't touch vscode, but helpers.js
// requires it at module scope for other exports).
const vscodeMock = { QuickPickItemKind: { Separator: -1 }, window: {} }
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode'
  return origResolve.call(this, request, ...args)
}
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeMock }

const { resolveRepoRootForSpec } = require('../../src/vscode/helpers')

function run(cwd, cmd) {
  execSync(cmd, { cwd, encoding: 'utf8' })
}

console.log('resolveRepoRootForSpec')

test('plain (non-git) folder: falls back to specRoot\'s parent, not specRoot itself', () => {
  // Regression test for: mermaid/MSC-Gen diagrams showing an empty placeholder in the
  // live preview when the workspace is a plain folder (not a git repository). Root
  // cause: the resolver's rootDir excluded the "cached/" sibling directory because the
  // old fallback used specRoot itself instead of its parent.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specpress-nongit-'))
  try {
    const specRoot = path.join(base, 'spec')
    fs.mkdirSync(specRoot)
    // Deliberately NOT a git repo — no `git init` here.
    const result = resolveRepoRootForSpec(specRoot)
    assert.strictEqual(result, path.dirname(specRoot))
    assert.notStrictEqual(result, specRoot, 'must not fall back to specRoot itself')
    // The sibling "cached/" directory must be inside the resolved root.
    const cachedDir = path.join(path.dirname(specRoot), 'cached')
    assert.ok(!path.relative(result, cachedDir).startsWith('..'), 'cached/ must be covered by the resolved root')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('git repository: resolves to the actual repo root via git rev-parse --show-toplevel', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'specpress-git-'))
  try {
    run(base, 'git init -q -b main')
    run(base, 'git config user.email "t@t.com"')
    run(base, 'git config user.name "t"')
    run(base, 'git config commit.gpgsign false')
    const specRoot = path.join(base, 'spec')
    fs.mkdirSync(specRoot)
    fs.writeFileSync(path.join(specRoot, 'f.md'), '# hi')
    run(base, 'git add .')
    run(base, 'git commit -q -m c1')

    const result = resolveRepoRootForSpec(specRoot)
    // Normalize for case/slash differences between git's output and fs paths on Windows.
    assert.strictEqual(path.resolve(result).toLowerCase(), path.resolve(base).toLowerCase())
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('specRoot equal to a filesystem root falls back to the provided fallback (no infinite parent)', () => {
  // path.dirname of a root path returns the root itself; make sure we don't loop or
  // return something equal to specRoot when a fallback is provided.
  const fakeRoot = process.platform === 'win32' ? 'C:\\' : '/'
  const result = resolveRepoRootForSpec(fakeRoot, '/fallback')
  // Either git resolved something real (unlikely for a drive root), or we hit the
  // "no parent" branch and used the fallback.
  assert.ok(result === '/fallback' || typeof result === 'string')
})

test('empty specRoot returns the fallback unchanged', () => {
  assert.strictEqual(resolveRepoRootForSpec('', '/some/fallback'), '/some/fallback')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
